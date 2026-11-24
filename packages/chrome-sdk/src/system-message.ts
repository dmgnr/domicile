// The compositor's answers to a system call, as a `system` event's `data`
// carries them. See docs/SHELL-SYSTEM-ACCESS.md. The rest of the
// compositor's protocol lives in @domicile-desktop/e2e-harness; a page hears
// only these three.

import { z } from "zod";

const systemErrorSchema = z.looseObject({
  kind: z.enum([
    "not_found",
    "permission_denied",
    "already_exists",
    "not_a_directory",
    "is_a_directory",
    "invalid_input",
    "locked",
    "dbus",
    "canceled",
    "compositor_gone",
    "other",
  ]),
  message: z.string(),
});

const fileTypeSchema = z.enum(["file", "directory", "symlink", "other"]);

// The answer to a `system_request`. Bytes are base64.
const systemReplySchema = z.looseObject({
  id: z.number(),
  reply: z.discriminatedUnion("kind", [
    z.looseObject({ data: z.string(), kind: z.literal("read") }),
    z.looseObject({ kind: z.literal("written") }),
    z.looseObject({ kind: z.literal("created") }),
    z.looseObject({
      entries: z.array(
        z.looseObject({ file_type: fileTypeSchema, name: z.string() }),
      ),
      kind: z.literal("entries"),
    }),
    z.looseObject({
      file_type: fileTypeSchema,
      kind: z.literal("stat"),
      modified_ms: z.number().nullable(),
      real_path: z.string().nullish(),
      size: z.number(),
    }),
    z.looseObject({
      body: z.string(),
      kind: z.literal("returned"),
      signature: z.string(),
    }),
    z.looseObject({ kind: z.literal("started") }),
    z.looseObject({ kind: z.literal("saved"), path: z.string() }),
    z.looseObject({ kind: z.literal("copied") }),
    z.looseObject({ frame: z.string(), kind: z.literal("preview") }),
    z.looseObject({ kind: z.literal("sent"), output: z.string().optional() }),
    z.looseObject({ kind: z.literal("set") }),
    z.looseObject({
      connected: z.array(
        z.looseObject({
          agent: z.string(),
          reach: z.unknown(),
          session: z.number(),
        }),
      ),
      kind: z.literal("agents"),
      remembered: z.array(
        z.looseObject({ agent: z.string(), last_used_ms: z.number() }),
      ),
    }),
    z.looseObject({ kind: z.literal("virtual_monitor"), output: z.string() }),
    z.looseObject({ error: systemErrorSchema, kind: z.literal("failed") }),
  ]),
  type: z.literal("system_reply"),
});

// Output from a running process, a change a watch saw, a signal a D-Bus match
// heard, a command `domicile send-shell` sent, an idle warning, or a
// passphrase the lock did not take, a client's window request, or the
// keymaps.
const systemEventSchema = z.looseObject({
  event: z.discriminatedUnion("kind", [
    z.looseObject({
      data: z.string(),
      kind: z.literal("output"),
      stream: z.enum(["stdout", "stderr"]),
    }),
    z.looseObject({ kind: z.literal("changed"), path: z.string() }),
    z.looseObject({
      body: z.string(),
      interface: z.string(),
      kind: z.literal("signal"),
      member: z.string(),
      path: z.string(),
      sender: z.string(),
      signature: z.string(),
    }),
    z.looseObject({
      command: z.array(z.string()),
      kind: z.literal("shell_command"),
      sent: z.number(),
    }),
    z.looseObject({
      app_id: z.string().optional(),
      kind: z.literal("link"),
      url: z.string(),
    }),
    z.looseObject({
      idle: z.boolean(),
      kind: z.literal("idle"),
    }),
    z.looseObject({
      holders: z.array(z.string()),
      kind: z.literal("idle_holds"),
    }),
    z.looseObject({
      failures: z.number(),
      kind: z.literal("unlock_refused"),
      refusal: z.enum(["wrong_passphrase", "unverifiable", "too_soon"]),
      retry_in_ms: z.number(),
    }),
    z.looseObject({
      app_id: z.string().nullable(),
      kind: z.literal("bell"),
    }),
    z.looseObject({
      app_id: z.string(),
      kind: z.literal("window_request"),
      request: z.discriminatedUnion("kind", [
        z.looseObject({ kind: z.literal("maximize") }),
        z.looseObject({ kind: z.literal("unmaximize") }),
        z.looseObject({
          display: z.string().nullable(),
          kind: z.literal("fullscreen"),
        }),
        z.looseObject({ kind: z.literal("unfullscreen") }),
        z.looseObject({ kind: z.literal("minimize") }),
        z.looseObject({ kind: z.literal("move") }),
        z.looseObject({
          edges: z.enum([
            "top",
            "bottom",
            "left",
            "right",
            "top_left",
            "top_right",
            "bottom_left",
            "bottom_right",
          ]),
          kind: z.literal("resize"),
        }),
      ]),
    }),
    z.looseObject({
      active: z.string(),
      keymaps: z.array(
        z.looseObject({
          description: z.string().optional(),
          name: z.string(),
        }),
      ),
      kind: z.literal("keymaps"),
    }),
  ]),
  id: z.number(),
  type: z.literal("system_event"),
});

// The last message for a watch, process or D-Bus match.
const systemEndSchema = z.looseObject({
  end: z.discriminatedUnion("kind", [
    z.looseObject({
      code: z.number().nullable(),
      kind: z.literal("exited"),
      signal: z.number().nullable(),
    }),
    z.looseObject({ kind: z.literal("stopped") }),
    z.looseObject({ error: systemErrorSchema, kind: z.literal("failed") }),
  ]),
  id: z.number(),
  type: z.literal("system_end"),
});

const systemMessageSchema = z.discriminatedUnion("type", [
  systemReplySchema,
  systemEventSchema,
  systemEndSchema,
]);

export type SystemReplyMessage = z.infer<typeof systemReplySchema>;
export type SystemEventMessage = z.infer<typeof systemEventSchema>;
export type SystemEndMessage = z.infer<typeof systemEndSchema>;
export type SystemMessage = z.infer<typeof systemMessageSchema>;

/**
 * Decode one `system` event's line. Throws on anything else: the engine
 * relays only these three types, so another is a bug.
 */
export const parseSystemMessage = (text: string): SystemMessage =>
  systemMessageSchema.parse(JSON.parse(text));
