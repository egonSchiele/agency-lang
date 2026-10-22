import { z } from "zod";

/** An Agency identifier, and never a prototype key: the one name rule
 *  for every local, argument, and global an edit writes. */
const identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an Agency variable name")
  .refine((name) => !["__proto__", "constructor", "prototype"].includes(name), {
    message: "not a prototype key",
  });

const branchPath = z.array(z.string()).optional();

/** A frame by its stack and its position on it. `depth` counts from the
 *  end of the stack, 0 the last frame; `scope` is the nearest frame of
 *  that scope name from the end. Neither means the frame the stop
 *  shows. */
export const frameAddressSchema = z.union([
  z.object({ branchPath, depth: z.number().int().min(0).optional() }).strict(),
  z.object({ branchPath, scope: z.string().min(1) }).strict(),
]);

/** A thread by id, by label, or the active one. */
export const threadAddressSchema = z.union([
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ label: z.string().min(1) }).strict(),
  z.object({ active: z.literal(true) }).strict(),
]);

/** A branch by its key path from the root, or by a key alone when it
 *  is unique. */
export const branchAddressSchema = z.union([
  z.object({ path: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ key: z.string().min(1) }).strict(),
]);

/** A guard by label, or by its index in the guards pane. */
export const guardAddressSchema = z.union([
  z.object({ label: z.string().min(1) }).strict(),
  z.object({ index: z.number().int().min(0) }).strict(),
]);

export type FrameAddress = z.infer<typeof frameAddressSchema>;
export type ThreadAddress = z.infer<typeof threadAddressSchema>;
export type BranchAddress = z.infer<typeof branchAddressSchema>;
export type GuardAddress = z.infer<typeof guardAddressSchema>;

/** The edits a checkpoint takes, each named for what a person wants.
 *  An omitted address means the stop's own: the frame the stop shows,
 *  the active thread, the nearest tool loop above the stop. */
export const checkpointEditSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("appendMessage"),
      thread: threadAddressSchema.optional(),
      role: z.enum(["user", "assistant"]).optional(),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("removeTool"),
      loop: z.object({ branchPath }).strict().optional(),
      tool: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("setGuard"),
      guard: guardAddressSchema,
      branchPath,
      limit: z.number().positive().optional(),
      disarmed: z.boolean().optional(),
    })
    .strict()
    .refine((edit) => edit.limit !== undefined || edit.disarmed !== undefined, {
      message: "a guard edit needs a limit, a disarmed flag, or both",
    }),
  z
    .object({
      op: z.literal("setLocal"),
      frame: frameAddressSchema.optional(),
      name: identifier,
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal("setBranchResult"),
      branch: branchAddressSchema,
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal("setArg"),
      frame: frameAddressSchema.optional(),
      name: identifier,
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal("setGlobal"),
      module: z.string().min(1).optional(),
      branchPath,
      name: identifier,
      value: z.unknown(),
    })
    .strict(),
]);

export const checkpointEditsSchema = z.array(checkpointEditSchema);

export type CheckpointEdit = z.infer<typeof checkpointEditSchema>;

/** Why an edit, an address, or a patched checkpoint was refused. One
 *  shape for the whole directory. */
export type Refusal = { refused: string };

export function isRefusal<T>(value: T | Refusal): value is Refusal {
  return typeof value === "object" && value !== null && "refused" in value;
}
