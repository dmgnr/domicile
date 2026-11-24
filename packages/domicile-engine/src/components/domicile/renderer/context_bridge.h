// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_RENDERER_CONTEXT_BRIDGE_H_
#define COMPONENTS_DOMICILE_RENDERER_CONTEXT_BRIDGE_H_

#include <string_view>

#include "v8/include/v8-forward.h"

namespace domicile {

// Electron's contextBridge: what a preload, in its isolated world, gives the
// page's main world. Neither world ever holds the other's objects:
//
// - Primitives pass as they are.
// - Arrays, plain objects, dates, errors and bytes are copied. Any other
//   object is copied as a plain object of its own enumerable properties.
//   Bytes arrive as a Uint8Array.
// - A function becomes a function of the receiving world that copies its
//   arguments over, calls the original in the original's own world, and
//   copies back its result or what it threw. Functions passed back as
//   arguments, such as callbacks, are wrapped the same way.
// - A promise becomes one of the receiving world that settles when the
//   original does, with the result copied.
//
// A value nested deeper than a thousand levels, a cycle included, is not
// copied: the copy throws a RangeError instead.

// `value`, which belongs to `from`, as a value of `to`. Empty with an
// exception pending when it cannot be copied.
v8::MaybeLocal<v8::Value> CopyAcrossWorlds(v8::Isolate* isolate,
                                           v8::Local<v8::Context> from,
                                           v8::Local<v8::Context> to,
                                           v8::Local<v8::Value> value);

// contextBridge.exposeInMainWorld: defines `key` on `to`'s global object as a
// copy of `value`, read-only and permanent. False with an exception pending
// when `key` is already there or `value` cannot be copied.
bool ExposeAcrossWorlds(v8::Isolate* isolate,
                        v8::Local<v8::Context> from,
                        v8::Local<v8::Context> to,
                        std::string_view key,
                        v8::Local<v8::Value> value);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_RENDERER_CONTEXT_BRIDGE_H_
