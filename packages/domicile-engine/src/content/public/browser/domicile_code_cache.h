// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CONTENT_PUBLIC_BROWSER_DOMICILE_CODE_CACHE_H_
#define CONTENT_PUBLIC_BROWSER_DOMICILE_CODE_CACHE_H_

#include "content/common/content_export.h"

namespace base {
class FilePath;
}  // namespace base

namespace content {

class StoragePartition;

// Keeps the code V8 compiles for `partition`'s scripts in `path` from now on,
// made when it is missing, as an Electron app's session.setCodeCachePath
// does. What the old directory holds stays there. UI thread only.
CONTENT_EXPORT void SetDomicileCodeCachePath(StoragePartition& partition,
                                             const base::FilePath& path);

}  // namespace content

#endif  // CONTENT_PUBLIC_BROWSER_DOMICILE_CODE_CACHE_H_
