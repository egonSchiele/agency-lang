// The wire between a running program and the debugger attached to it: one
// long-lived two-way channel. The run side holds the driver and sends a
// request for each `DebuggerIO` method it calls; the UI side answers with
// a reply carrying the method's return value. One-way methods (`log`,
// `setMode`, the spinner) are notices and get no reply. Three messages are
// not methods: `hello` from the run when the connection opens, `finished`
// from the run when the program ends, and `refused` when a debugger is
// already attached. Closing the channel, from either side, is the detach.
//
// A checkpoint crosses as `checkpoint.toJSON()` run through the native
// type replacer, the way `debugStep` prepares the `onCheckpoint` payload,
// and comes back through `Checkpoint.fromJSON` after the reviver.
import { z } from "zod";

/** The `DebuggerIO` methods that expect an answer. */
export const REQUEST_METHODS = [
  "render",
  "waitForCommand",
  "showRewindSelector",
  "answerGuardTrip",
  "showCheckpointsPanel",
  "promptForNodeArgs",
  "promptForInput",
] as const;

/** The `DebuggerIO` methods that return at once. */
export const NOTICE_METHODS = [
  "log",
  "setMode",
  "setOverrides",
  "appendStdout",
  "renderActivityOnly",
  "startSpinner",
  "stopSpinner",
] as const;

export type RequestMethod = (typeof REQUEST_METHODS)[number];
export type NoticeMethod = (typeof NOTICE_METHODS)[number];

export const HelloSchema = z
  .object({
    type: z.literal("hello"),
    program: z.string(),
    node: z.string(),
    pid: z.number().int().positive(),
  })
  .strict();

export const AttachMessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  z.object({ type: z.literal("finished"), value: z.unknown() }).strict(),
  z.object({ type: z.literal("refused"), reason: z.string() }).strict(),
  z
    .object({
      type: z.literal("request"),
      id: z.number().int().nonnegative(),
      method: z.enum(REQUEST_METHODS),
      args: z.array(z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal("reply"),
      id: z.number().int().nonnegative(),
      result: z.unknown().optional(),
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("notice"),
      method: z.enum(NOTICE_METHODS),
      args: z.array(z.unknown()),
    })
    .strict(),
]);

export type AttachMessage = z.infer<typeof AttachMessageSchema>;
export type Hello = z.infer<typeof HelloSchema>;

/** A parsed JSON value as one of our messages, or null when it is not
 *  one. The sender is the other half of this package, so a bad message is
 *  a bug; the run side drops it and the UI side reports it through its
 *  `malformed` event. Neither throws across the channel. */
export function parseAttachMessage(message: unknown): AttachMessage | null {
  const parsed = AttachMessageSchema.safeParse(message);
  return parsed.success ? parsed.data : null;
}

const DebuggerCommandSchema = z.union([
  z.object({ type: z.enum(["step", "next", "stepIn", "stepOut", "continue", "rewind"]) }),
  z.object({ type: z.literal("checkpoint"), label: z.string().optional() }),
  z.object({ type: z.literal("set"), varName: z.string(), value: z.unknown() }),
  z.object({ type: z.literal("approve") }),
  z.object({ type: z.literal("reject"), value: z.unknown().optional() }),
  z.object({ type: z.literal("resolve"), value: z.unknown() }),
  z.object({ type: z.literal("modify"), overrides: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("stepBack"), preserveOverrides: z.boolean() }),
  z.object({ type: z.literal("showCheckpoints") }),
  z.object({ type: z.literal("save"), path: z.string() }),
  z.object({ type: z.literal("load"), path: z.string() }),
  z.object({ type: z.literal("quit") }),
]);

const InterruptResponseSchema = z.object({
  type: z.enum(["approve", "reject"]),
  value: z.unknown().optional(),
});

/** What each request's reply must carry. The run side checks a reply
 *  against this before handing it to the driver, so a UI that answers
 *  with the wrong shape ends the session instead of crashing the
 *  program. */
export const REPLY_SCHEMAS: Record<RequestMethod, z.ZodType> = {
  render: z.undefined(),
  waitForCommand: DebuggerCommandSchema,
  showRewindSelector: z.number().nullable(),
  answerGuardTrip: InterruptResponseSchema,
  showCheckpointsPanel: z.undefined(),
  promptForNodeArgs: z.array(z.unknown()),
  promptForInput: z.string(),
};
