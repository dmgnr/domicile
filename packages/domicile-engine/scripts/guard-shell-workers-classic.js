// A classic worker for guard-shell-workers.sh: dedicated or shared, it answers
// every message with GUARD_WORD.
importScripts("guard-shell-workers-word.js");

const answer = (port) => {
  port.onmessage = () => port.postMessage(self.GUARD_WORD);
};

self.onconnect = (event) => answer(event.ports[0]);
answer(self);
