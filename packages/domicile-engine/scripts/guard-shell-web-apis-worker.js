// The worker guard-shell-web-apis.js shares memory with. Adds one to the
// first integer of the SharedArrayBuffer it is sent, then says so.

addEventListener("message", ({ data }) => {
  Atomics.add(data, 0, 1);
  postMessage("added");
});
