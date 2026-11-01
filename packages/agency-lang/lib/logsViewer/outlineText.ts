// One trace's story outline as plain records: the rows the trace screen
// draws by default, each with its address and the header `session show`
// prints for it. `agency logs outline` prints these.
import { formatAddress } from "./address.js";
import { headerLine } from "./rowText.js";
import { hiddenByDefault, storyOutline, type StoryRow } from "./story.js";
import type { TreeNode } from "./types.js";

export type OutlineLine = {
  address: string;
  rowId: string;
  kind: StoryRow["kind"];
  depth: number;
  header: string;
};

/** `approvals` shows approved interrupts, as `p` does. `admin` adds the
 *  handler decisions under each interrupt, as the viewer's admin toggle
 *  does, and with them the approvals they sit under. */
export type OutlineFlags = { approvals: boolean; admin: boolean };

/** Every row the trace screen would draw with these toggles, in its order. */
export function outlineLines(trace: TreeNode, flags: OutlineFlags): OutlineLine[] {
  const showApprovals = flags.approvals || flags.admin;
  return storyOutline(trace, { admin: flags.admin })
    .filter((row) => showApprovals || !hiddenByDefault(row))
    .map((row) => ({
      address: formatAddress(trace.traceId, row.id),
      rowId: row.id,
      kind: row.kind,
      depth: row.depth,
      header: headerLine(row, trace),
    }));
}
