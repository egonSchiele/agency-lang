import { actionsFor, type EditAction } from "./actions.js";
import { rowsFor, type PaneName, type PaneRow, type StopView } from "./rows.js";

/** One thing the palette offers: an edit on a row, named by the action's
 *  sentence, with where the row is so the UI can move the cursor there. */
export type PaletteEntry = {
  sentence: string;
  pane: PaneName;
  rowIndex: number;
  row: PaneRow;
  action: EditAction;
};

/** The panes whose rows take edits, in the order the palette lists them. */
const PANES: PaneName[] = ["threads", "locals", "globals", "callStack", "branches", "guards"];

/** Every edit every row offers at `view`, pane by pane, row by row, in
 *  the action table's order on each row. */
export function paletteEntries(view: StopView): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const pane of PANES) {
    rowsFor(pane, view).forEach((row, rowIndex) => {
      for (const action of actionsFor(row, view)) {
        entries.push({ sentence: action.sentence(row, view), pane, rowIndex, row, action });
      }
    });
  }
  return entries;
}

/** The entries whose sentence contains `query`, ignoring case; every
 *  entry when the query is blank. */
export function filterPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return entries;
  return entries.filter((entry) => entry.sentence.toLowerCase().includes(wanted));
}
