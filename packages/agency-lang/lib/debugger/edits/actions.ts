import type { CheckpointEdit } from "../../runtime/state/checkpointPatch/index.js";
import { formatValue } from "../util.js";
import type { PaneName, PaneRow, RowKind, StopView } from "./rows.js";

/** Whether an action is offered on a row, or why not, which the footer
 *  prints. */
export type Offered = { offered: true } | { offered: false; reason: string };

/** The one value an action asks the person to type, if any: the message
 *  text, a local's value as JSON, a guard's amount. */
export type Asks = { label: string; kind: "text" | "json" | "amount" };

/** An edit the debugger offers, anchored to the pane row it acts on.
 *  The terminal reads the table to put the key on the row, print the
 *  footer hint, and run the edit; `agency debug session` exposes each
 *  row as an `edit` verb. Neither names an action. */
export type EditAction = {
  /** The verb: `append-message`, and the row's id in `--json`. */
  name: string;
  /** The pane and the kind of row the edit sits on. */
  anchor: { pane: PaneName; row: RowKind };
  /** The key on that row, which the footer prints. */
  key: string;
  /** The footer word for the row: "send", "set", "disarm". */
  hint: (row: PaneRow, view: StopView) => string;
  /** The palette sentence, of the row: "disarm the guard research". */
  sentence: (row: PaneRow, view: StopView) => string;
  applies: (row: PaneRow, view: StopView) => Offered;
  asks?: Asks;
  /** The edits the row and the typed value mean. */
  toEdits: (row: PaneRow, value: unknown, view: StopView) => CheckpointEdit[];
};

const threadName = (row: Extract<PaneRow, { kind: "thread" }>) => row.label ?? row.id;

const appendMessage: EditAction = {
  name: "append-message",
  anchor: { pane: "threads", row: "thread" },
  key: "enter",
  hint: () => "send",
  sentence: (row) =>
    row.kind === "thread"
      ? `append a message to thread ${threadName(row)} (${row.messageCount} messages)`
      : "",
  applies: () => ({ offered: true }),
  asks: { label: "say something to the model", kind: "text" },
  toEdits: (row, value) =>
    row.kind === "thread"
      ? [{ op: "appendMessage", thread: { id: row.id }, text: String(value) }]
      : [],
};

const setLocal: EditAction = {
  name: "set-local",
  anchor: { pane: "locals", row: "local" },
  key: "enter",
  hint: () => "set",
  sentence: (row, view) => {
    if (row.kind !== "local") return "";
    const stack = view.checkpoint.stackAt(row.frame.branchPath) ?? [];
    const scope = stack.at(-1 - row.frame.depth)?.scopeName ?? "(unknown)";
    return `set ${row.name} in ${scope} (now ${formatValue(row.value)})`;
  },
  applies: () => ({ offered: true }),
  asks: { label: "=", kind: "json" },
  toEdits: (row, value) =>
    row.kind === "local"
      ? [{ op: row.arg ? "setArg" : "setLocal", frame: row.frame, name: row.name, value }]
      : [],
};

/** Every edit the debugger offers. A new edit is one record here and
 *  one test; the panes and the verbs read the table. */
export const EDIT_ACTIONS: EditAction[] = [appendMessage, setLocal];

/** The actions offered on `row` at `view`, in table order. */
export function actionsFor(row: PaneRow, view: StopView): EditAction[] {
  return EDIT_ACTIONS.filter(
    (action) => action.anchor.row === row.kind && action.applies(row, view).offered,
  );
}

export function actionByName(name: string): EditAction | undefined {
  return EDIT_ACTIONS.find((action) => action.name === name);
}

/** The label the one-line form shows for `action` on `row`: the field's
 *  own words, after the row's name when the field is a value. */
export function askLabel(action: EditAction, row: PaneRow): string {
  const asks = action.asks;
  if (!asks) return "";
  return row.kind === "local" && asks.kind === "json" ? `${row.name} ${asks.label}` : asks.label;
}
