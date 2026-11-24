// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/renderer/context_bridge.h"

#include <string>
#include <string_view>

#include "gin/test/v8_test.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-object.h"
#include "v8/include/v8-primitive.h"
#include "v8/include/v8-script.h"
#include "v8/include/v8-value.h"

namespace domicile {
namespace {

// Two worlds: the preload's, where a value starts, and the page's, where its
// copy goes. Each knows its own name as `world`.
class ContextBridgeTest : public gin::V8Test {
 protected:
  void SetUp() override {
    gin::V8Test::SetUp();
    v8::HandleScope handle_scope(isolate());
    preload_.Reset(isolate(), v8::Context::New(isolate()));
    page_.Reset(isolate(), v8::Context::New(isolate()));
    Run(preload(), "globalThis.world = 'preload'");
    Run(page(), "globalThis.world = 'page'");
  }

  void TearDown() override {
    preload_.Reset();
    page_.Reset();
    gin::V8Test::TearDown();
  }

  v8::Isolate* isolate() { return instance_->isolate(); }
  v8::Local<v8::Context> preload() { return preload_.Get(isolate()); }
  v8::Local<v8::Context> page() { return page_.Get(isolate()); }

  v8::Local<v8::Value> Run(v8::Local<v8::Context> context,
                           std::string_view source) {
    v8::Context::Scope scope(context);
    v8::Local<v8::String> text =
        v8::String::NewFromUtf8(isolate(), source.data(),
                                v8::NewStringType::kNormal,
                                static_cast<int>(source.size()))
            .ToLocalChecked();
    return v8::Script::Compile(context, text)
        .ToLocalChecked()
        ->Run(context)
        .ToLocalChecked();
  }

  // What `source` gives in the page, as a string.
  std::string InPage(std::string_view source) {
    v8::Local<v8::Value> result = Run(page(), source);
    v8::String::Utf8Value text(isolate(), result);
    return *text;
  }

  // Exposes what `source` gives in the preload as the page's `api`.
  void Expose(std::string_view source) {
    v8::Local<v8::Value> value = Run(preload(), source);
    v8::TryCatch try_catch(isolate());
    ASSERT_TRUE(ExposeAcrossWorlds(isolate(), preload(), page(), "api", value));
    ASSERT_FALSE(try_catch.HasCaught());
  }

  v8::Global<v8::Context> preload_;
  v8::Global<v8::Context> page_;
};

TEST_F(ContextBridgeTest, CopiesPrimitives) {
  v8::HandleScope handle_scope(isolate());
  Expose("({n: 1.5, s: 'hi', b: true, z: null, u: undefined})");
  EXPECT_EQ(InPage("JSON.stringify(api)"),
            R"({"n":1.5,"s":"hi","b":true,"z":null})");
  EXPECT_EQ(InPage("'u' in api && api.u === undefined"), "true");
}

TEST_F(ContextBridgeTest, ObjectsAndArraysBelongToThePage) {
  v8::HandleScope handle_scope(isolate());
  Expose("({list: [1, {deep: 2}], when: new Date(5)})");
  EXPECT_EQ(InPage("Object.getPrototypeOf(api) === Object.prototype"), "true");
  EXPECT_EQ(InPage("Array.isArray(api.list) && api.list instanceof Array"),
            "true");
  EXPECT_EQ(InPage("api.list[1] instanceof Object && api.list[1].deep"), "2");
  EXPECT_EQ(InPage("api.when instanceof Date && api.when.getTime()"), "5");
}

// gin's tests run V8 in strict mode, so both refusals throw here; a page's
// sloppy scripts see them fail quietly instead.
TEST_F(ContextBridgeTest, ExposedApiIsReadOnly) {
  v8::HandleScope handle_scope(isolate());
  Expose("({})");
  EXPECT_EQ(InPage("const was = api; let refused = 0; "
                   "try { api = 1; } catch (e) { refused++; } "
                   "try { delete globalThis.api; } catch (e) { refused++; } "
                   "refused + ' ' + (api === was)"),
            "2 true");
}

TEST_F(ContextBridgeTest, RefusesANameThePageHas) {
  v8::HandleScope handle_scope(isolate());
  Run(page(), "globalThis.api = 'mine'");
  v8::Local<v8::Value> value = Run(preload(), "({})");
  v8::TryCatch try_catch(isolate());
  EXPECT_FALSE(ExposeAcrossWorlds(isolate(), preload(), page(), "api", value));
  EXPECT_TRUE(try_catch.HasCaught());
  EXPECT_EQ(InPage("api"), "mine");
}

TEST_F(ContextBridgeTest, FunctionsRunInThePreload) {
  v8::HandleScope handle_scope(isolate());
  Expose(
      "({where: (x) => ({world, got: x.n + 1, "
      "sameObject: Object.getPrototypeOf(x) === Object.prototype})})");
  EXPECT_EQ(InPage("JSON.stringify(api.where({n: 1}))"),
            R"({"world":"preload","got":2,"sameObject":true})");
  EXPECT_EQ(InPage("Object.getPrototypeOf(api.where({n: 1})) === "
                   "Object.prototype"),
            "true");
}

TEST_F(ContextBridgeTest, CallbacksRunInThePage) {
  v8::HandleScope handle_scope(isolate());
  Expose("({call: (callback) => callback(world)})");
  EXPECT_EQ(InPage("api.call((from) => from + ' to ' + world)"),
            "preload to page");
}

TEST_F(ContextBridgeTest, ThrowsCrossAsThePagesErrors) {
  v8::HandleScope handle_scope(isolate());
  Expose("({fail: () => { throw new TypeError('nope'); }})");
  EXPECT_EQ(InPage("try { api.fail(); 'no throw' } catch (e) { "
                   "(e instanceof Error) + ' ' + e.message }"),
            "true nope");
}

TEST_F(ContextBridgeTest, PromisesSettleInThePage) {
  v8::HandleScope handle_scope(isolate());
  Expose(
      "({later: () => Promise.resolve({v: 7}), "
      "never: () => Promise.reject(new Error('no'))})");
  Run(page(),
      "const p = api.later(); globalThis.isPromise = p instanceof Promise; "
      "p.then((x) => { globalThis.got = (Object.getPrototypeOf(x) === "
      "Object.prototype) + ' ' + x.v; }); "
      "api.never().catch((e) => { globalThis.why = (e instanceof Error) + ' ' "
      "+ e.message; })");
  isolate()->PerformMicrotaskCheckpoint();
  EXPECT_EQ(InPage("isPromise"), "true");
  EXPECT_EQ(InPage("got"), "true 7");
  EXPECT_EQ(InPage("why"), "true no");
}

TEST_F(ContextBridgeTest, CopiesBytes) {
  v8::HandleScope handle_scope(isolate());
  Expose("({bytes: new Uint16Array([1, 256]), buffer: new ArrayBuffer(3)})");
  EXPECT_EQ(InPage("api.bytes instanceof Uint8Array && api.bytes.join()"),
            "1,0,0,1");
  EXPECT_EQ(InPage("api.buffer instanceof ArrayBuffer && "
                   "api.buffer.byteLength"),
            "3");
}

TEST_F(ContextBridgeTest, RefusesACycle) {
  v8::HandleScope handle_scope(isolate());
  v8::Local<v8::Value> value =
      Run(preload(), "const loop = {}; loop.self = loop; loop");
  v8::TryCatch try_catch(isolate());
  EXPECT_FALSE(ExposeAcrossWorlds(isolate(), preload(), page(), "api", value));
  EXPECT_TRUE(try_catch.HasCaught());
  EXPECT_EQ(InPage("typeof api"), "undefined");
}

TEST_F(ContextBridgeTest, AFunctionIsNotAConstructor) {
  v8::HandleScope handle_scope(isolate());
  Expose("({make: function () { return 1; }})");
  EXPECT_EQ(InPage("try { new api.make(); 'made' } catch (e) { e.name }"),
            "TypeError");
}

}  // namespace
}  // namespace domicile
