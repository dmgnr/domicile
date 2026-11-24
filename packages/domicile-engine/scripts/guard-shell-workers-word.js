// What guard-shell-workers.sh's workers reply. A classic worker reads it with
// importScripts() and a module worker with import, so a reply means the
// worker's own subresources load too.
self.GUARD_WORD = "replied";
