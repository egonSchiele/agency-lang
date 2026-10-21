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

import type { InterruptResponse } from "../../runtime/interruptResponse.js";
import type { DebuggerCommand, DebuggerIO } from "../types.js";

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
  z
    .object({
      type: z.literal("finished"),
      /** Optional: a node that returns nothing, or a run that threw, has
       *  no value, and JSON drops a key whose value is undefined. zod 4
       *  treats a plain `unknown` key as required. */
      value: z.unknown().optional(),
      /** Set when the run ended by throwing; `value` is then nothing. */
      error: z.string().optional(),
    })
    .strict(),
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

const InterruptResponseSchema = z.union([
  z.object({ type: z.literal("approve"), value: z.any().optional() }),
  z.object({ type: z.literal("reject"), value: z.string().optional() }),
]);

/** The two schemas above are written by hand, so this ties each to the
 *  type it checks, in both directions: a command added to
 *  `DebuggerCommand` without a line here, or a field the type requires
 *  that the schema makes optional, fails to compile instead of ending
 *  every attached session the first time someone uses it. */
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const commandSchemaMatchesType: SameShape<
  z.infer<typeof DebuggerCommandSchema>,
  DebuggerCommand
> = true;
const responseSchemaMatchesType: SameShape<
  z.infer<typeof InterruptResponseSchema>,
  InterruptResponse
> = true;
void commandSchemaMatchesType;
void responseSchemaMatchesType;

/** What each request's reply must carry. The run side checks a reply
 *  against this before handing it to the driver, so a UI that answers
 *  with the wrong shape ends the session instead of crashing the
 *  program. */
export const REPLY_SCHEMAS = {
  render: z.void(),
  waitForCommand: DebuggerCommandSchema,
  showRewindSelector: z.number().nullable(),
  answerGuardTrip: InterruptResponseSchema,
  showCheckpointsPanel: z.void(),
  promptForNodeArgs: z.array(z.unknown()),
  promptForInput: z.string(),
};

/** Each reply schema must produce exactly what the matching `DebuggerIO`
 *  method returns, in both directions: a schema that is wider would let a
 *  wrong answer through, and one that is narrower (`showRewindSelector`
 *  without `.nullable()`) would end the session on a right one. */
type ReplySchemasMatch = {
  [M in RequestMethod]: SameShape<
    z.infer<(typeof REPLY_SCHEMAS)[M]>,
    Awaited<ReturnType<DebuggerIO[M]>>
  >;
};
const replySchemasMatchTypes: ReplySchemasMatch = {
  render: true,
  waitForCommand: true,
  showRewindSelector: true,
  answerGuardTrip: true,
  showCheckpointsPanel: true,
  promptForNodeArgs: true,
  promptForInput: true,
};
void replySchemasMatchTypes;
