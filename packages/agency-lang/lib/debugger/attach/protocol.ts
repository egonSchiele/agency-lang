// The wire between a running program and the debugger attached to it: one
// long-lived two-way channel. The run side holds the driver and sends a
// request for each `DebuggerIO` method it calls; the UI side answers with
// a reply carrying the method's return value. One-way methods (`log`,
// `setMode`, the spinner) are notices and get no reply. Five messages are
// not methods: `client`, the first message a connection sends, saying
// what it is (`sessionRules.ts` has what follows from that); `hello` from
// the run when a party joins; `finished` from the run when the program
// ends; `refused` when a party cannot join; and `status`, the answer a
// probe gets. One message goes the other way unprompted: `pause` from the
// UI, asking the running program to stop at its next statement. A
// terminal debugger's connection is its session, so closing it is the
// detach; a CLI visit's session is held by the run between visits.
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
  "setBusy",
  "appendStdout",
  "renderActivityOnly",
  "startSpinner",
  "stopSpinner",
] as const;

export type RequestMethod = (typeof REQUEST_METHODS)[number];
export type NoticeMethod = (typeof NOTICE_METHODS)[number];

/** What a connection says it is, in its first message. A `terminal` is
 *  a person's debugger, whose connection is its session; a `cli` is one
 *  visit of `agency debug session`, whose session the run holds between
 *  visits; a `probe` wants the session's state and nothing else. */
export const CLIENT_KINDS = ["terminal", "cli", "probe"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** The CLI's hold on a session, as `status` reports it. */
const CliStatusSchema = z
  .object({
    visiting: z.boolean(),
    /** When the last visit closed, as a timestamp; null while one is
     *  connected and before the first has closed. */
    lastVisit: z.number().nullable(),
  })
  .strict();

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
  z.object({ type: z.literal("client"), kind: z.enum(CLIENT_KINDS) }).strict(),
  z
    .object({
      type: z.literal("status"),
      terminal: z.boolean(),
      cli: CliStatusSchema.nullable(),
      /** Whether the driver is waiting on an answer: the program is
       *  stopped at a debug stop, or at a selector or prompt. */
      stopped: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("pause") }).strict(),
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
export type RequestMessage = Extract<AttachMessage, { type: "request" }>;
export type NoticeMessage = Extract<AttachMessage, { type: "notice" }>;
export type FinishedMessage = Extract<AttachMessage, { type: "finished" }>;
export type StatusMessage = Extract<AttachMessage, { type: "status" }>;

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
