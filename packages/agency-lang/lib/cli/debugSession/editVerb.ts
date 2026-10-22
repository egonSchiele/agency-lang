// The `edit` verbs, generated from the debugger's action table: one verb
// per action, the row it acts on named by a choice flag, the value it
// asks for by a typed flag. With no action, the verbs this stop takes.
import { actionByName, EDIT_ACTIONS, type EditAction } from "@/debugger/edits/actions.js";
import { rowsFor, type PaneRow, type RowKind, type StopView } from "@/debugger/edits/rows.js";
import type { CheckpointEdit } from "@/runtime/state/checkpointPatch/index.js";
import type { Shown } from "./visit.js";
import { parseAmount } from "@/debugger/guardAnswer.js";
import type { PendingPreview } from "@/debugger/edits/rows.js";

/** How a row kind is named on the command line, and which value of the
 *  row the flag matches. */
type ChoiceFlag = {
  flag: string;
  /** The words a refusal uses: "no local y at this stop; the locals are x". */
  noun: string;
  /** The tokens that pick the row, the one the listing prints first:
   *  a label before an id, since that is what a person copies. */
  keys: (row: PaneRow) => string[];
  /** The row taken when the flag is omitted, if any. */
  defaultRow?: (rows: PaneRow[]) => PaneRow | undefined;
};

const CHOICE_FLAGS: Partial<Record<RowKind, ChoiceFlag>> = {
  thread: {
    flag: "thread",
    noun: "thread",
    keys: (row) => (row.kind === "thread" ? [...(row.label ? [row.label] : []), row.id] : []),
    defaultRow: (rows) => rows.find((row) => row.kind === "thread" && row.active) ?? rows[0],
  },
  local: { flag: "name", noun: "local", keys: (row) => (row.kind === "local" ? [row.name] : []) },
  guard: {
    flag: "guard",
    noun: "guard",
    keys: (row) =>
      row.kind === "guard" ? [...(row.label ? [row.label] : []), String(row.index)] : [],
  },
  branch: {
    flag: "branch",
    noun: "branch",
    keys: (row) => (row.kind === "branch" ? [row.key] : []),
  },
  tool: {
    flag: "tool",
    noun: "tool",
    // Two loops along the branch path can offer the same tool, so a tool
    // is also named with its loop: `search@root`, `search@tool_0_abc`.
    keys: (row) => (row.kind === "tool" ? [row.name, `${row.name}@${loopName(row.loop)}`] : []),
  },
};

/** The loop a tool row is under, for the `name@loop` spelling: the
 *  branch path of the loop's stack, `root` for the root stack. */
function loopName(loop: { branchPath: string[] }): string {
  return loop.branchPath.length === 0 ? "root" : loop.branchPath.join("/");
}

/** The token the listing prints for `row`: its first key, unless another
 *  row shares it, then the first key no other row has. */
function tokenFor(row: PaneRow, rows: PaneRow[], choice: ChoiceFlag): string {
  const keys = choice.keys(row);
  const others = rows.filter((other) => other !== row).flatMap((other) => choice.keys(other));
  return keys.find((key) => !others.includes(key)) ?? keys[0];
}

/** The flag that carries the typed value, by what the action asks for. */
const ASK_FLAGS = { text: "text", json: "value", amount: "amount" } as const;

/** Every flag the `edit` leaf declares, for the command tree. */
export const EDIT_FLAGS: { flag: string; help: string }[] = [
  { flag: "thread", help: "The thread, by label or id; the active one when omitted" },
  { flag: "name", help: "The local or argument" },
  { flag: "guard", help: "The guard, by label or index" },
  { flag: "branch", help: "The branch, by key" },
  { flag: "tool", help: "The tool, by name" },
  { flag: "text", help: "The text to send" },
  { flag: "value", help: "The new value, as JSON (text when it is not JSON)" },
  { flag: "amount", help: "A guard amount: dollars, or a duration such as 30s" },
];

export type EditRequest = { action?: string; values: Record<string, unknown>; drop: boolean };

/** The view a visit's stop gives the edit tables. */
export function viewOf(shown: Shown, pending: PendingPreview): StopView | null {
  const checkpoint = shown.checkpoint;
  if (!checkpoint) return null;
  const at = {
    branchPath: shown.stop?.branchPath ?? checkpoint.branchPath,
    loopStop: shown.stop?.loopStop ?? checkpoint.loopStop,
  };
  const moduleId = shown.stop?.moduleId ?? checkpoint.moduleId;
  return { checkpoint, stop: at, viewed: at, moduleId, pending };
}

/** The rows `action` is offered on at this view. */
function rowsOffered(action: EditAction, view: StopView): PaneRow[] {
  return rowsFor(action.anchor.pane, view).filter(
    (row) => row.kind === action.anchor.row && action.applies(row, view).offered,
  );
}

export type EditListing = {
  name: string;
  flags: (
    | { flag: string; choices: string[]; default: string | null }
    | { flag: string; kind: "text" | "json" | "amount" }
  )[];
};

/** The verbs this stop takes, each with its flags, choices, and default. */
export function listEdits(view: StopView): EditListing[] {
  const listing: EditListing[] = [];
  for (const action of EDIT_ACTIONS) {
    const rows = rowsOffered(action, view);
    const choice = CHOICE_FLAGS[action.anchor.row];
    if (rows.length === 0 || choice === undefined) continue;
    const fallback = choice.defaultRow?.(rows);
    const flags: EditListing["flags"] = [
      {
        flag: choice.flag,
        choices: rows.map((row) => tokenFor(row, rows, choice)),
        default: fallback === undefined ? null : tokenFor(fallback, rows, choice),
      },
    ];
    if (action.asks !== undefined) {
      flags.push({ flag: ASK_FLAGS[action.asks.kind], kind: action.asks.kind });
    }
    listing.push({ name: action.name, flags });
  }
  return listing;
}

export function listingText(listing: EditListing[]): string {
  if (listing.length === 0) return "no edits apply at this stop";
  const lines = listing.map((entry) => {
    const flags = entry.flags.map((flag) =>
      "choices" in flag
        ? `--${flag.flag} <${flag.choices.join("|")}>${flag.default === null ? "" : ` [${flag.default}]`}`
        : `--${flag.flag} <${flag.kind}>`,
    );
    return `  ${entry.name.padEnd(18)} ${flags.join("  ")}`;
  });
  return ["At this stop:", ...lines].join("\n");
}

/** The edits `request` means at `view`, or why it cannot be made. */
export function editsFor(
  request: EditRequest,
  view: StopView,
): { edits: CheckpointEdit[] } | { refused: string } {
  const action = request.action === undefined ? undefined : actionByName(request.action);
  if (action === undefined) {
    const names = EDIT_ACTIONS.map((candidate) => candidate.name).join(", ");
    return { refused: `no edit named ${request.action}; the edits are ${names}` };
  }
  const choice = CHOICE_FLAGS[action.anchor.row];
  if (choice === undefined) return { refused: `${action.name} has no row to act on` };
  const rows = rowsOffered(action, view);
  const wanted = request.values[choice.flag];
  const matching =
    wanted === undefined
      ? []
      : rows.filter((candidate) => choice.keys(candidate).includes(String(wanted)));
  if (matching.length > 1) {
    const names = matching.map((candidate) => tokenFor(candidate, rows, choice)).join(", ");
    return {
      refused: `${String(wanted)} names ${matching.length} ${choice.noun}s; say which: ${names}`,
    };
  }
  const row = wanted === undefined ? choice.defaultRow?.(rows) : matching[0];
  if (row === undefined) {
    const have = rows.map((candidate) => tokenFor(candidate, rows, choice)).join(", ");
    return {
      refused:
        rows.length === 0
          ? `no ${choice.noun} at this stop`
          : wanted === undefined
            ? `${action.name} needs --${choice.flag}; the ${choice.noun}s are ${have}`
            : `no ${choice.noun} ${String(wanted)} at this stop; the ${choice.noun}s are ${have}`,
    };
  }
  let value: unknown = undefined;
  if (action.asks !== undefined) {
    const flag = ASK_FLAGS[action.asks.kind];
    value = request.values[flag];
    if (value === undefined) return { refused: `${action.name} needs --${flag}` };
    if (action.asks.kind === "amount") {
      const dimension = row.kind === "guard" ? row.dimension : "cost";
      const amount = parseAmount(dimension, String(value));
      if (amount === null) {
        return {
          refused:
            dimension === "cost"
              ? `--amount takes dollars, such as 0.5, not "${String(value)}"`
              : `--amount takes a duration, such as 30s or 2m, not "${String(value)}"`,
        };
      }
      value = amount;
    }
  }
  return { edits: action.toEdits(row, value, view) };
}
