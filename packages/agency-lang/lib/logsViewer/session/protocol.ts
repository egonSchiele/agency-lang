// The wire between `agency logs session …` and a running viewer: one
// newline-delimited JSON request per connection, one reply, close. Three
// requests. There is no request that writes a comment: the CLI writes
// through its own store, under its own author, and then sends `reload`.
import { z } from "zod";

import type { Focus } from "./port.js";

export const SessionRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get") }).strict(),
  z
    .object({ op: z.literal("navigate"), traceId: z.string().min(1), rowId: z.string().optional() })
    .strict(),
  z.object({ op: z.literal("reload") }).strict(),
]);
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

export type FocusReply = Focus & { logPath: string; commentsPath: string | undefined };

export type SessionReply = { ok: true; focus?: FocusReply } | { ok: false; error: string };

/** The default wait for a reply. A suspended viewer accepts the connection
 *  (the kernel queues it) and never answers; without this, `session list`
 *  would hang on it. */
export const SESSION_TIMEOUT_MS = 1_500;
