# Agents

Agents such as Claude Code drive the desktop through `domicile mcp`
([CLI.md](CLI.md#domicile-mcp)). The user decides what each one may reach,
sees it in the bar the whole time it's in, and can stop it.

## For users

The user guide's [Agents](use/AGENTS.md) page is the short version of this.

1. Add the server to the agent: `claude mcp add domicile -- domicile mcp`.
2. The first time the agent uses a tool, Domicile asks: **Let Claude Code use
   your desktop?**
   - **Entire desktop**: every window, plus your pointer and keyboard.
   - **Only these windows**: the windows you check. The agent reads and drives
     them through their accessibility trees and their own screenshots, and
     never moves your pointer or types elsewhere. Private browser windows are
     never offered.
   - **Remember for Claude Code**, shown with the entire desktop, lets it in
     from then on without asking.
   - Cancel, or a minute without an answer, refuses it.
3. While it's in, a violet pill with its name sits in the bar. Every session
   shares the one pill, which counts them when there are several and reads
   "Agents" when they're different agents. Click it to see what each can reach
   and did last, **Change** to give it more or less, and **Stop** to end it.
   **Stop all** ends every session. Canceling a change keeps what it has.
4. An agent you cancel or stop is refused from then on, until you ask it to
   try again: its `ask_to_use_desktop` tool, or its next session, asks again.
   After a stop it asks even when it is remembered.
   An agent done with the desktop ends its own session with
   `stop_using_desktop`; its next tool call asks again, as its first did.
5. **Settings › Agents** lists each agent connected now or remembered, with
   what it reaches and when it was last used. **Stop** ends its sessions;
   **Forget** makes it ask again.
6. While any agent is in, apps are told to build accessibility trees (AT-SPI's
   `IsEnabled`), so Qt, Firefox and similar apps can be read as text. It goes
   back off when the last agent leaves, unless it was on before. An app
   started before may need a restart.

Agents are refused while the desktop is locked.

### Agents that sign in

An agent that connects to a URL, rather than running `domicile mcp` itself,
uses `domicile mcp --http 127.0.0.1:7465`
([CLI.md](CLI.md#over-http)). The first time it connects, it opens a page
that waits while the desktop asks whether to let it sign in. Page and dialog
show the same number: **Allow** signs it in. It still asks, as above, before it uses anything.

### Agents on the web

An agent on the web, such as claude.ai, can't reach a desk behind a router.
Turning on **Connect from the web** in Settings › Agents (`agents.web`,
[SHELL-CONFIG.md](SHELL-CONFIG.md#agents)) has the desktop run `domicile mcp
--relay` ([CLI.md](CLI.md#through-the-relay)), which dials out to a relay
(below). Settings then shows the desk's address,
`https://<label>.mcp.domicile-desktop.com/mcp`, with a Copy button, to add to
the agent as a custom connector, and whether it is ready. When it can't get
ready it says why, with **Try again**. Signing in and
asking work as above. Each agent signed in is listed there too: **Sign out**
drops its tokens, so it asks to sign in again.

## Design

```
agent ── MCP (stdio) ── domicile mcp ── domicile agent <name> ── control socket
                             │                                        │
                             │ every tool call is checked             supervisor
                             │ against the grant                      │ (agent_lending)
                             ▼                                        ▼
                        domicile <verb>                  compositor: system call `agent`
                                                          │ portal queue: `agent` dialog
                                                          │ capturing: `agent` session
                                                          ▼
                                                        shell (PortalDialogs, bar)
```

- **The desk holds the grant; `domicile mcp` enforces it.** `domicile mcp`
  runs `domicile agent <name>` on its first tool call and holds it for as long
  as it serves. That connection is the grant: while it's open the session is
  listed, and when the shell stops the session the compositor hangs up, which
  `domicile mcp` reads as stopped. Each tool call checks the grant first
  (`mcp::guarded`). With only some windows, `list_windows` lists only those,
  `close_window` and the browser and app tools take only those, and every tool
  that reaches the whole desk is refused.
- **It guards consent, not a hostile process.** A local agent that can run
  `domicile` itself can bypass `domicile mcp`; so can anything else running as
  the user. The ask is about the user knowing and choosing what an agent they
  connect may touch. A remote agent reaches the desk only through
  `domicile mcp`, which holds the grant.
- **The ask is a portal dialog, though no portal asks.** The `agent` system
  call (`SystemRequest::Agent`) puts a `PortalKind::Agent` dialog in the queue
  every portal uses, so a shell draws it with its other dialogs and a shell
  that doesn't know it refuses it like any unknown kind. The answer is
  `PortalAnswer::Agent { reach }`; the compositor drops windows the dialog
  didn't offer (`portals::agent`).
- **A session is a capturing session.** `CapturingKind::Agent` carries the
  agent's name, its reach and its last five actions, newest first. The shell
  stops it with the stop every session takes. `domicile mcp` reports each
  action as one line, such as `Clicked in Notes`, never what it typed.
- **The name is the agent's own word.** It comes from the client's
  `initialize` (`clientInfo.title`, else `name`) and is not checked.
- **Only the whole desk is remembered.** A list of windows means nothing in
  the next session, so `PortalAnswer::Agent { remember }` is refused with
  windows. The compositor keeps remembered agents, by name, with when each was
  last let in, in `$XDG_STATE_HOME/domicile/agents.json` (`portals::agent`).
  A file it can't read remembers nobody, so each agent asks again. Since the
  name is the agent's own word, any agent that calls itself a remembered name
  is let in; remembering trusts the agents the user connects, as the rest of
  this does.
- **A change asks again, from the session.** `PortalAnswer::Change` on an
  agent session puts the dialog up again, with its reach picked and
  `current` set. Its answer replaces the reach, and the holder of the grant
  gets `SystemEvent::AgentReach`, which `domicile agent` prints as another
  line and `domicile mcp` applies from the next tool call. The whole desk
  with Remember on remembers it; anything else forgets it.
- **Settings lists and forgets through system calls.** `agents` lists
  sessions and remembered agents, `stop_agent` ends a session and
  `forget_agent` forgets a name. `domicile list-agents`, `stop-agent` and
  `forget-agent` are the same, and Settings' host calls them on the control
  socket. All three are refused while the desk is locked, and to apps.
- **Private windows are never offered.** The dialog lists every window but
  private browser windows, and the engine refuses DevTools on them anyway.
- **Signing in is allowed on the desk; the dialog still decides.**
  `domicile mcp --http` is its own OAuth 2.1 authorization server
  (`mcp::oauth`): dynamic registration, PKCE S256 only, and an authorization
  page that waits while the desk asks "Let <client> sign in to your
  desktop?" through its own `Access` portal, naming the site it goes back
  to (redirects with a user in the address are refused) and a four-digit
  number the page shows too, so the user allows their own browser's request
  and someone who merely has the URL can't sign in. The page reloads itself (no script) holding a secret ask id, bound to that
  request's client, redirect, challenge and state; an answer lets in once.
  One ask at a time, two minutes to answer; someone with the URL can keep
  that one ask busy, but not get past it. A token only reaches `/mcp`;
  each session is an `Agent`, as on stdio, on a thread of its own, and asks
  at its first tool call. Access tokens last an hour and refresh tokens
  rotate.
- **A conversation is one agent, however many sessions it opens.** ChatGPT
  opens a session for each tool call, and names its chat in the call's
  `_meta["openai/session"]`. A tool call that names a conversation goes to
  that conversation's `Agent`, shared by every session of the same signed-in
  client in it, so a chat asks once, shows one pill, and `stop_using_desktop`
  ends it whichever session sends it. A call that names none goes to its
  session's own `Agent`, which is how Claude, with one session per chat,
  stays per chat. Conversations, like sessions, end after 30 minutes unused.
  The first tool call of each session logs its client and its `_meta` keys,
  to see what another client names its chats with. The `Host` and `Origin` checks keep
  a web page on another site from reaching a server on `localhost`.

## The relay

Agents on the web, such as claude.ai, connect from the internet, and most
desks are behind a router. `domicile-relay` (`packages/domicile-relay`, `nix
run .#relay`) runs on a server and passes their connections to the desk
without being able to read them:

```
claude.ai ── TLS for <label>.<zone> ──▶ relay :443 ──── spliced ────▶ desk
                                          │  reads only the            ▲
                                          │  ClientHello's name        │ dials out; opens one
                                          └── "open <token>" ──────────┘ connection per client
```

- **A desk's address is named for its key.** The desk dials the relay's desk
  port (7444), sends its Ed25519 public key and signs a challenge; its
  address is `<label>.<zone>`, the label 16 base32 letters of the key's
  SHA-256. Nobody can take an address without its key. A desk dialing in
  again replaces its old connection.
- **TLS ends on the desk.** The relay reads the server name from the
  ClientHello, which is sent in the clear, asks the desk on its connection to
  open one back with a one-time token, and splices the two, the ClientHello
  first. A client for no desk, or for a name outside the zone, is hung up on.
  So the relay holds no key that decrypts what the agent and desk say; the
  desk holds the certificate for its address.
- **Its operator could still get a certificate for an address,** since they
  run the zone's DNS. Certificate Transparency logs would show it, and
  signing in still needs the user to allow it on the desk, so they could not
  sign an agent in unseen.
- **Each address needs its own certificate.** Let's Encrypt allows 50 a week
  per registered domain, so a zone shared by many desks needs to be on the
  Public Suffix List.
- **The desk's side** (`domicile mcp --relay`, `mcp::web`) keeps its key,
  its ACME account and its certificate in
  `$XDG_STATE_HOME/domicile/relay.json`, readable only by its user. It gets
  the certificate from Let's Encrypt with TLS-ALPN-01: the authority connects
  to the address through the relay, and the desk answers `acme-tls/1` with
  the challenge's certificate, so nothing about the zone's DNS is needed. It
  renews after 60 days, retries hourly, dials again when the relay hangs up,
  waiting up to five minutes, and sends a blank line every 30 seconds so a
  quiet connection isn't dropped. Each connection's TLS ends on the desk, and
  what's inside goes to the HTTP server on 127.0.0.1.
- **Domicile's own relay is `mcp.domicile-desktop.com`,** on fly.io
  (`packages/domicile-relay/fly.toml`), deployed by `.github/workflows/relay.yml`
  each time main changes it. Set up once: `fly apps create domicile-relay`,
  `fly ips allocate-v4`, and the repository secret `FLY_API_TOKEN` from `fly
  tokens create deploy -a domicile-relay`. Anyone can run another: it needs
  two plain TCP ports, a wildcard DNS name for the zone, and one process,
  since a desk and the agents reaching it must meet on the same relay.

## Shells

`<PortalDialogs />` draws the dialog (`AgentDialog`) and lists a running agent
in its capturing indicator. A shell that shows agents itself, as Manganese's
bar does, passes `omitAgents`. The SDK parses the dialog as `PortalKind.Agent`,
answers it with `PortalAnswer.Agent(reach, remember)`, and lists a session as
`CapturingKind.Agent`. `body.current` is set when the dialog changes a running
agent, and `body.remembered` when the agent is remembered.
`domicile.portals.changeAgent(id)` asks again for a running agent;
`agents()` and `forgetAgent(agent)` back a settings page.
