import type { CheckpointEdit } from "../../runtime/state/checkpointPatch/index.js";
import { formatValue } from "../util.js";
import { formatElapsed } from "../busy.js";
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

const removeTool: EditAction = {
  name: "remove-tool",
  anchor: { pane: "callStack", row: "tool" },
  key: "e",
  hint: () => "remove",
  sentence: (row) => (row.kind === "tool" ? `remove ${row.name} from this loop` : ""),
  applies: (row) =>
    row.kind === "tool" && row.removed
      ? { offered: false, reason: `${row.name} is already removed` }
      : { offered: true },
  toEdits: (row) =>
    row.kind === "tool" ? [{ op: "removeTool", loop: row.loop, tool: row.name }] : [],
};

const guardWords = (row: Extract<PaneRow, { kind: "guard" }>) => {
  const amount =
    row.dimension === "cost"
      ? `$${Number(row.spent.toFixed(6))} of $${row.limit}`
      : `${formatElapsed(row.spent)} of ${formatElapsed(row.limit)}`;
  return `the guard ${row.label ?? "(unlabelled)"} (${row.dimension}, ${amount})`;
};

const guardOffered = (row: PaneRow): Offered => {
  if (row.kind !== "guard") return { offered: false, reason: "not a guard" };
  if (row.root) return { offered: false, reason: "the root budget is the host's ceiling" };
  return { offered: true };
};

const disarmGuard: EditAction = {
  name: "disarm-guard",
  anchor: { pane: "guards", row: "guard" },
  key: "e",
  hint: () => "disarm",
  sentence: (row) => (row.kind === "guard" ? `disarm ${guardWords(row)}` : ""),
  applies: (row) =>
    row.kind === "guard" && row.disarmed
      ? { offered: false, reason: `${row.label ?? "the guard"} is already disarmed` }
      : guardOffered(row),
  toEdits: (row, _value, view) =>
    row.kind === "guard"
      ? [
          {
            op: "setGuard",
            guard: { index: row.index },
            branchPath: view.viewed.branchPath,
            disarmed: true,
          },
        ]
      : [],
};

const setGuardLimit: EditAction = {
  name: "set-guard-limit",
  anchor: { pane: "guards", row: "guard" },
  key: "b",
  hint: () => "budget",
  sentence: (row) => (row.kind === "guard" ? `change the budget of ${guardWords(row)}` : ""),
  applies: guardOffered,
  asks: { label: "new budget (30s, 2m, or $0.50)", kind: "amount" },
  toEdits: (row, value, view) =>
    row.kind === "guard" && typeof value === "number"
      ? [
          {
            op: "setGuard",
            guard: { index: row.index },
            branchPath: view.viewed.branchPath,
            limit: value,
          },
        ]
      : [],
};

const setBranchResult: EditAction = {
  name: "set-branch-result",
  anchor: { pane: "branches", row: "branch" },
  key: "e",
  hint: () => "result",
  sentence: (row) =>
    row.kind === "branch" ? `give the branch ${row.key} (${row.label}) a result` : "",
  applies: (row) => {
    if (row.kind !== "branch") return { offered: false, reason: "not a branch" };
    if (row.key.startsWith("tool_")) {
      return { offered: false, reason: "a tool call's result is the loop's to record" };
    }
    // A branch stopped on an interrupt takes a result too: the debugger's
    // own stop is one, and a resume skips a branch that has a result.
    if (row.status === "done") return { offered: false, reason: `${row.key} has finished` };
    return { offered: true };
  },
  asks: { label: "result =", kind: "json" },
  toEdits: (row, value) =>
    row.kind === "branch" ? [{ op: "setBranchResult", branch: { path: row.path }, value }] : [],
};

/** Every edit the debugger offers. A new edit is one record here and
 *  one test; the panes and the verbs read the table. */
export const EDIT_ACTIONS: EditAction[] = [
  appendMessage,
  setLocal,
  removeTool,
  disarmGuard,
  setGuardLimit,
  setBranchResult,
];

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
