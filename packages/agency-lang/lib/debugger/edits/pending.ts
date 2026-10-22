import type { HostSettings } from "../../host/host.js";
import {
  patchCheckpoint,
  type CheckpointEdit,
  type StopAt,
} from "../../runtime/state/checkpointPatch/index.js";
import type { Checkpoint } from "../../runtime/state/checkpointStore.js";
import type { FrameRef } from "./rows.js";

/** The checkpoint as it will be once `edits` are applied, with the line
 *  for each, or the refusals. The driver runs this when an edit is
 *  queued, for the refusal; each UI runs it to draw the preview. Pure,
 *  so the two agree. */
export function previewOf(
  checkpoint: Checkpoint,
  edits: CheckpointEdit[],
  settings: HostSettings,
  at?: StopAt,
): { checkpoint: Checkpoint; applied: string[] } | { refused: string[] } {
  return patchCheckpoint(checkpoint, edits, settings, at);
}

/** The names a pending `setLocal` or `setArg` changes on `frame`, so the
 *  locals pane can mark them. */
export function pendingLocals(edits: CheckpointEdit[], frame: FrameRef): string[] {
  const names: string[] = [];
  for (const edit of edits) {
    if (edit.op !== "setLocal" && edit.op !== "setArg") continue;
    const target = edit.frame;
    const sameStack = (target?.branchPath ?? []).join("/") === frame.branchPath.join("/");
    const sameDepth = target !== undefined && "depth" in target && target.depth === frame.depth;
    if (sameStack && (sameDepth || target === undefined)) names.push(edit.name);
  }
  return names;
}
