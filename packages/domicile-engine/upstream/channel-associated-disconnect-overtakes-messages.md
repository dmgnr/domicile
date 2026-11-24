# Upstream bug: a channel-associated disconnect can overtake its messages (unfiled)

Not filed: issues.chromium.org needs a Google account, so a person must file it.

- **Why we care:** lyra logged `Message N rejected by interface
  blink.mojom.Widget` after resume and during browsing.
- **Fix here:** patch 0261. `ChannelDisconnectOrderTest` covers it.
- **Status:** read at pin `4a1889aeff83`. Re-read `ipc/ipc_mojo_bootstrap.cc`
  at trunk before filing.

The report below is ready to paste.

---

**Title:** `ChannelAssociatedGroupController` posts a disconnect to a different
task runner than the endpoint's messages, so it can run first

**Component:** Internals>Mojo
**Type:** Bug

## What happens

`ipc/ipc_mojo_bootstrap.cc`:

- `Accept()` queues a message for an endpoint it can't dispatch in place on
  `proxy_task_runner_`, unless the endpoint was bound off-sequence.
- `NotifyEndpointOfError()` posts the disconnect to `endpoint->task_runner()`.
- Blink binds `blink.mojom.Widget` to a frame's task runner, a different queue
  on the main thread from the channel's proxy task runner.

So when the browser calls a `Widget` and then closes it, the renderer can run
the disconnect first. The call then hits `encountered_error_` in
`InterfaceEndpointClient::HandleValidatedMessage`, is dropped, and logs
`Message N rejected by interface blink.mojom.Widget`.

## Fix

Post the disconnect to the task runner `Accept()` would dispatch messages on.
From there, hop to `endpoint->task_runner()` if it isn't the current sequence.

- Cost: an endpoint on another thread hears a disconnect only after the proxy
  task runner runs.
- Not covered: messages that arrive before an endpoint binds are queued on the
  proxy task runner. If it then binds off-sequence, its disconnect can still
  overtake them.
