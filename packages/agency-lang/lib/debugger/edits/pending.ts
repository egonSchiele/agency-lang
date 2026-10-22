import type { HostSettings } from "../../host/host.js";
import {
  patchCheckpoint,
  type CheckpointEdit,
  type StopAt,
} from "../../runtime/state/checkpointPatch/index.js";
import type { Checkpoint } from "../../runtime/state/checkpointStore.js";

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
