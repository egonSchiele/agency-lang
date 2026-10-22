import type { HostSettings } from "../../../host/host.js";
import { signCheckpoint } from "../../checkpointChecksum.js";
import { deepClone } from "../../utils.js";
import { Checkpoint, type CheckpointJSON } from "../checkpointStore.js";
import { stopOfCheckpoint, type StopAt } from "./addresses.js";
import { isRefusal, type CheckpointEdit } from "./edits.js";
import { fieldKind } from "./fieldKinds.js";
import { getAt, setAt } from "./jsonPath.js";
import { resolve, type Write } from "./lower.js";
import { validate } from "./validate.js";

export type { CheckpointEdit, Refusal } from "./edits.js";
export { checkpointEditSchema, checkpointEditsSchema } from "./edits.js";
export type { StopAt } from "./addresses.js";
export { stopOfCheckpoint } from "./addresses.js";

export type PatchResult = { checkpoint: Checkpoint; applied: string[] } | { refused: string[] };

/** The three shapes a resume took before edits: locals, args, and
 *  globals, each a name-value map, written to the checkpoint's own
 *  frame and module. */
export type ResumeOverrides = {
  locals?: Record<string, unknown>;
  args?: Record<string, unknown>;
  globals?: Record<string, unknown>;
};

/** A new checkpoint with `edits` applied to a copy of `source`, in
 *  order, validated against the source's invariants, and re-signed
 *  under `settings` when the source was signed; or every reason an
 *  edit was refused, with no checkpoint, so a caller never resumes a
 *  partly edited one. `at` is the stop the edits are made at; a
 *  checkpoint on its own is its own stop. */
export function patchCheckpoint(
  source: Checkpoint,
  edits: CheckpointEdit[],
  settings: HostSettings,
  at: StopAt = stopOfCheckpoint(source),
): PatchResult {
  const refused: string[] = [];
  const writes: Write[] = [];
  for (const edit of edits) {
    const lowered = resolve(edit, source, at);
    if (isRefusal(lowered)) {
      refused.push(lowered.refused);
      continue;
    }
    writes.push(...lowered);
  }
  const json = deepClone(source.toJSON());
  refused.push(...applyWrites(json, writes));
  if (refused.length > 0) return { refused };
  const broken = validate(source.toJSON(), json);
  if (broken.length > 0) return { refused: broken.map((r) => r.refused) };
  const checkpoint = Checkpoint.fromJSON(json);
  if (!checkpoint) return { refused: ["shape: the patched checkpoint does not parse"] };
  if (source.signature !== undefined) {
    signCheckpoint(checkpoint, settings);
  }
  return { checkpoint, applied: writes.map((write) => write.applied) };
}

/** Write every write into `json`, after checking each path names a data
 *  field; the reasons any did not, and nothing written when one did. */
function applyWrites(json: CheckpointJSON, writes: Write[]): string[] {
  const refused = writes.flatMap((write) => {
    const kind = fieldKind(write.jsonPath, scopeNameAlong(json, write.jsonPath));
    return kind === "data"
      ? []
      : [`${write.jsonPath.join(".")} is a ${kind} field; see the field-kind table`];
  });
  if (refused.length > 0) return refused;
  for (const write of writes) {
    if (!setAt(json, write.jsonPath, write.value)) {
      refused.push(`${write.jsonPath.join(".")} has no parent to write into`);
    }
  }
  return refused;
}

/** The scope name of the frame `path` runs through, when it runs
 *  through one: the deepest prefix that reads as a frame. */
function scopeNameAlong(json: CheckpointJSON, path: string[]): string | null {
  for (let length = path.length - 1; length > 0; length--) {
    const value = getAt(json, path.slice(0, length)) as { scopeName?: unknown; locals?: unknown };
    if (value && typeof value === "object" && "locals" in value && "scopeName" in value) {
      return typeof value.scopeName === "string" ? value.scopeName : null;
    }
  }
  return null;
}

/** The old override shapes as edits on the frame at `at`, the
 *  checkpoint's own stop when the caller has no stop record. */
export function fromOverrides(
  overrides: ResumeOverrides,
  checkpoint: Checkpoint,
  at: StopAt = stopOfCheckpoint(checkpoint),
): CheckpointEdit[] {
  const edits: CheckpointEdit[] = [];
  const frame = { branchPath: at.branchPath };
  for (const [name, value] of entries(overrides.locals)) {
    edits.push({ op: "setLocal", frame, name, value });
  }
  for (const [name, value] of entries(overrides.args)) {
    edits.push({ op: "setArg", frame, name, value });
  }
  for (const [name, value] of entries(overrides.globals)) {
    edits.push({ op: "setGlobal", branchPath: at.branchPath, name, value });
  }
  return edits;
}

function entries(map: Record<string, unknown> | undefined): [string, unknown][] {
  const pairs = Object.entries(map ?? {});
  for (const [name] of pairs) {
    if (name === "__proto__" || name === "constructor" || name === "prototype") {
      throw new Error(`Resume request contains invalid override name "${name}"`);
    }
  }
  return pairs;
}
