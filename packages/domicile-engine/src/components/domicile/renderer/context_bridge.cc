// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/renderer/context_bridge.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include "v8/include/v8-array-buffer.h"
#include "v8/include/v8-container.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-date.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-function-callback.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-object.h"
#include "v8/include/v8-primitive.h"
#include "v8/include/v8-promise.h"
#include "v8/include/v8-typed-array.h"
#include "v8/include/v8-value.h"

namespace domicile {
namespace {

// Deep enough for any real API; a cycle reaches it quickly.
constexpr int kMaxDepth = 1000;

v8::MaybeLocal<v8::Value> Copy(v8::Isolate* isolate,
                               v8::Local<v8::Context> from,
                               v8::Local<v8::Context> to,
                               v8::Local<v8::Value> value,
                               int depth);

v8::Local<v8::String> Text(v8::Isolate* isolate, std::string_view text) {
  return v8::String::NewFromUtf8(isolate, text.data(),
                                 v8::NewStringType::kNormal,
                                 static_cast<int>(text.size()))
      .ToLocalChecked();
}

// Throws a `make` error (v8::Exception::Error, TypeError, ...) of `to`.
void Throw(v8::Isolate* isolate,
           v8::Local<v8::Context> to,
           v8::Local<v8::Value> (*make)(v8::Local<v8::String>,
                                        v8::Local<v8::Value>),
           std::string_view message) {
  v8::Context::Scope scope(to);
  isolate->ThrowException(make(Text(isolate, message), {}));
}

// A wrapped function's body: calls the original, the callback's data, in its
// own world.
void CallOriginal(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  // An API function runs in the context it was made in: the caller's world.
  v8::Local<v8::Context> caller = isolate->GetCurrentContext();
  v8::Local<v8::Function> original = info.DataV2().As<v8::Function>();
  v8::Local<v8::Context> home;
  if (!original->GetCreationContext(isolate).ToLocal(&home)) {
    Throw(isolate, caller, v8::Exception::Error,
          "the world this function belongs to is gone");
    return;
  }
  std::vector<v8::Local<v8::Value>> arguments;
  arguments.reserve(info.Length());
  for (int i = 0; i < info.Length(); ++i) {
    v8::Local<v8::Value> argument;
    if (!Copy(isolate, caller, home, info[i], 0).ToLocal(&argument)) {
      return;
    }
    arguments.push_back(argument);
  }
  v8::Local<v8::Value> result;
  v8::Local<v8::Value> thrown;
  {
    v8::TryCatch try_catch(isolate);
    v8::Context::Scope scope(home);
    if (!original
             ->Call(isolate, home, v8::Undefined(isolate),
                    static_cast<int>(arguments.size()), arguments.data())
             .ToLocal(&result)) {
      if (!try_catch.HasCaught() || !try_catch.CanContinue()) {
        // Terminating: there is nothing to copy back.
        try_catch.ReThrow();
        return;
      }
      thrown = try_catch.Exception();
    }
  }
  if (!thrown.IsEmpty()) {
    v8::Local<v8::Value> copied;
    if (Copy(isolate, home, caller, thrown, 0).ToLocal(&copied)) {
      isolate->ThrowException(copied);
    }
    return;
  }
  v8::Local<v8::Value> copied;
  if (Copy(isolate, home, caller, result, 0).ToLocal(&copied)) {
    info.GetReturnValue().Set(copied);
  }
}

// A copied promise's settling: the callback's data is the resolver of the
// copy, and the one argument is what the original settled with.
void Settle(const v8::FunctionCallbackInfo<v8::Value>& info, bool fulfilled) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> home = isolate->GetCurrentContext();
  v8::Local<v8::Promise::Resolver> resolver =
      info.DataV2().As<v8::Promise::Resolver>();
  v8::Local<v8::Context> there;
  if (!resolver->GetCreationContext(isolate).ToLocal(&there)) {
    return;
  }
  v8::Local<v8::Value> settled;
  {
    v8::TryCatch try_catch(isolate);
    if (!Copy(isolate, home, there, info[0], 0).ToLocal(&settled)) {
      if (!try_catch.CanContinue()) {
        try_catch.ReThrow();
        return;
      }
      // What it settled with cannot cross, so the copy rejects with why.
      settled = try_catch.Exception();
      fulfilled = false;
      v8::Local<v8::Value> why;
      if (!Copy(isolate, home, there, settled, 0).ToLocal(&why)) {
        return;
      }
      settled = why;
    }
  }
  v8::Context::Scope scope(there);
  // Nothing only while terminating, when nothing is left to settle for.
  if (fulfilled) {
    std::ignore = resolver->Resolve(there, settled);
  } else {
    std::ignore = resolver->Reject(there, settled);
  }
}

void Fulfilled(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Settle(info, /*fulfilled=*/true);
}

void Rejected(const v8::FunctionCallbackInfo<v8::Value>& info) {
  Settle(info, /*fulfilled=*/false);
}

v8::MaybeLocal<v8::Value> CopyFunction(v8::Isolate* isolate,
                                       v8::Local<v8::Context> to,
                                       v8::Local<v8::Function> original) {
  v8::Context::Scope scope(to);
  v8::Local<v8::Function> wrapper;
  if (!v8::Function::New(to, &CallOriginal, original, /*length=*/0,
                         v8::ConstructorBehavior::kThrow)
           .ToLocal(&wrapper)) {
    return {};
  }
  return wrapper;
}

v8::MaybeLocal<v8::Value> CopyPromise(v8::Isolate* isolate,
                                      v8::Local<v8::Context> from,
                                      v8::Local<v8::Context> to,
                                      v8::Local<v8::Promise> original) {
  v8::Local<v8::Promise::Resolver> resolver;
  {
    v8::Context::Scope scope(to);
    if (!v8::Promise::Resolver::New(to).ToLocal(&resolver)) {
      return {};
    }
  }
  {
    v8::Context::Scope scope(from);
    v8::Local<v8::Function> fulfilled;
    v8::Local<v8::Function> rejected;
    if (!v8::Function::New(from, &Fulfilled, resolver).ToLocal(&fulfilled) ||
        !v8::Function::New(from, &Rejected, resolver).ToLocal(&rejected) ||
        original->Then(from, fulfilled, rejected).IsEmpty()) {
      return {};
    }
  }
  return resolver->GetPromise();
}

v8::MaybeLocal<v8::Value> CopyError(v8::Isolate* isolate,
                                    v8::Local<v8::Context> from,
                                    v8::Local<v8::Context> to,
                                    v8::Local<v8::Object> original) {
  v8::Local<v8::Value> message;
  v8::Local<v8::String> text;
  if (!original->Get(from, Text(isolate, "message")).ToLocal(&message) ||
      !message->ToString(from).ToLocal(&text)) {
    return {};
  }
  v8::Context::Scope scope(to);
  return v8::Exception::Error(text);
}

v8::MaybeLocal<v8::Value> CopyBytes(v8::Isolate* isolate,
                                    v8::Local<v8::Context> to,
                                    v8::Local<v8::Value> original) {
  std::unique_ptr<v8::BackingStore> store;
  if (original->IsArrayBufferView()) {
    v8::Local<v8::ArrayBufferView> view = original.As<v8::ArrayBufferView>();
    store = v8::ArrayBuffer::NewBackingStore(isolate, view->ByteLength());
    view->CopyContents(store->Data(), store->ByteLength());
  } else {
    v8::Local<v8::ArrayBuffer> buffer = original.As<v8::ArrayBuffer>();
    store = v8::ArrayBuffer::NewBackingStore(isolate, buffer->ByteLength());
    if (store->ByteLength() > 0) {
      std::copy_n(static_cast<const uint8_t*>(buffer->Data()),
                  store->ByteLength(), static_cast<uint8_t*>(store->Data()));
    }
  }
  const size_t length = store->ByteLength();
  v8::Context::Scope scope(to);
  v8::Local<v8::ArrayBuffer> copy =
      v8::ArrayBuffer::New(isolate, std::move(store));
  if (original->IsArrayBuffer()) {
    return copy;
  }
  return v8::Uint8Array::New(copy, 0, length);
}

v8::MaybeLocal<v8::Value> CopyArray(v8::Isolate* isolate,
                                    v8::Local<v8::Context> from,
                                    v8::Local<v8::Context> to,
                                    v8::Local<v8::Array> original,
                                    int depth) {
  const uint32_t length = original->Length();
  v8::Local<v8::Array> copy;
  {
    v8::Context::Scope scope(to);
    copy = v8::Array::New(isolate, static_cast<int>(length));
  }
  for (uint32_t i = 0; i < length; ++i) {
    v8::Local<v8::Value> element;
    v8::Local<v8::Value> copied;
    if (!original->Get(from, i).ToLocal(&element) ||
        !Copy(isolate, from, to, element, depth + 1).ToLocal(&copied) ||
        copy->CreateDataProperty(to, i, copied).IsNothing()) {
      return {};
    }
  }
  return copy;
}

v8::MaybeLocal<v8::Value> CopyObject(v8::Isolate* isolate,
                                     v8::Local<v8::Context> from,
                                     v8::Local<v8::Context> to,
                                     v8::Local<v8::Object> original,
                                     int depth) {
  v8::Local<v8::Array> keys;
  if (!original
           ->GetOwnPropertyNames(from,
                                 static_cast<v8::PropertyFilter>(
                                     v8::ONLY_ENUMERABLE | v8::SKIP_SYMBOLS),
                                 v8::KeyConversionMode::kConvertToString)
           .ToLocal(&keys)) {
    return {};
  }
  v8::Local<v8::Object> copy;
  {
    v8::Context::Scope scope(to);
    copy = v8::Object::New(isolate);
  }
  for (uint32_t i = 0; i < keys->Length(); ++i) {
    v8::Local<v8::Value> key;
    v8::Local<v8::Value> field;
    v8::Local<v8::Value> copied;
    if (!keys->Get(from, i).ToLocal(&key) ||
        !original->Get(from, key).ToLocal(&field) ||
        !Copy(isolate, from, to, field, depth + 1).ToLocal(&copied) ||
        copy->CreateDataProperty(to, key.As<v8::Name>(), copied).IsNothing()) {
      return {};
    }
  }
  return copy;
}

v8::MaybeLocal<v8::Value> Copy(v8::Isolate* isolate,
                               v8::Local<v8::Context> from,
                               v8::Local<v8::Context> to,
                               v8::Local<v8::Value> value,
                               int depth) {
  if (depth > kMaxDepth) {
    Throw(isolate, to, v8::Exception::RangeError,
          "an object passed between a preload and its page is nested too "
          "deeply, or holds itself");
    return {};
  }
  if (!value->IsObject()) {
    // Primitives belong to no world.
    return value;
  } else if (value->IsFunction()) {
    return CopyFunction(isolate, to, value.As<v8::Function>());
  } else if (value->IsPromise()) {
    return CopyPromise(isolate, from, to, value.As<v8::Promise>());
  } else if (value->IsNativeError()) {
    return CopyError(isolate, from, to, value.As<v8::Object>());
  } else if (value->IsArrayBuffer() || value->IsArrayBufferView()) {
    return CopyBytes(isolate, to, value);
  } else if (value->IsDate()) {
    v8::Context::Scope scope(to);
    return v8::Date::New(to, value.As<v8::Date>()->ValueOf());
  } else if (value->IsArray()) {
    return CopyArray(isolate, from, to, value.As<v8::Array>(), depth);
  } else {
    return CopyObject(isolate, from, to, value.As<v8::Object>(), depth);
  }
}

}  // namespace

v8::MaybeLocal<v8::Value> CopyAcrossWorlds(v8::Isolate* isolate,
                                           v8::Local<v8::Context> from,
                                           v8::Local<v8::Context> to,
                                           v8::Local<v8::Value> value) {
  return Copy(isolate, from, to, value, 0);
}

bool ExposeAcrossWorlds(v8::Isolate* isolate,
                        v8::Local<v8::Context> from,
                        v8::Local<v8::Context> to,
                        std::string_view key,
                        v8::Local<v8::Value> value) {
  v8::Local<v8::Object> global = to->Global();
  v8::Local<v8::String> name = Text(isolate, key);
  v8::Maybe<bool> taken = global->HasOwnProperty(to, name);
  if (taken.IsNothing()) {
    return false;
  } else if (taken.FromJust()) {
    Throw(isolate, from, v8::Exception::Error,
          "contextBridge cannot expose an API over a name the page's window "
          "already has");
    return false;
  }
  v8::Local<v8::Value> copied;
  if (!Copy(isolate, from, to, value, 0).ToLocal(&copied)) {
    return false;
  }
  return global
      ->DefineOwnProperty(
          to, name, copied,
          static_cast<v8::PropertyAttribute>(v8::ReadOnly | v8::DontDelete))
      .FromMaybe(false);
}

}  // namespace domicile
