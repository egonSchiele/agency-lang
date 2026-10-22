/** What kind of field a path in a checkpoint's JSON names. Data is what
 *  an edit may change. Control is what moves the program counter or
 *  rewrites what the tool loop believes it has done. Identity is what
 *  names the checkpoint, its code, and its threads. The frame's scope
 *  name is needed because the tool loop keeps its bookkeeping in locals
 *  under names a user's function may use for values. */
export type FieldKind = "data" | "control" | "identity";

const IDENTITY_TOP = ["id", "moduleId", "nodeId", "moduleFingerprints", "signature", "traceId"];
const IDENTITY_LEAVES = ["id", "guardId"];
const CONTROL_LEAVES_OF_STACK = ["nodesTraversed", "deserializeStackLength", "mode", "other"];
const CONTROL_GUARD_FIELDS = ["spent", "elapsedMs", "grantedMs"];
/** The loop frame's locals an edit may change; every other local of a
 *  `runPrompt` frame is bookkeeping. The thread copy's two lists are
 *  named as paths under `messagesJSON`. */
const LOOP_DATA_LOCALS = ["removedTools"];
const LOOP_DATA_THREAD_LISTS = ["messages", "queuedMessages"];

/** The kind of the field at `path`, in a frame of `scopeName` when the
 *  path runs through a frame. A program's own variable is data whatever
 *  it is called: the leaf-name rules (`id`, `step`) apply only outside
 *  a frame's variables and a module's globals, so a function with
 *  `let id = …` or a loop counter named `step` can still be set. The
 *  one exception is the loop frame, whose locals are the runtime's. */
export function fieldKind(path: string[], scopeName: string | null): FieldKind {
  const leaf = path.at(-1);
  if (leaf === undefined) return "identity";
  if (path.length === 1 && IDENTITY_TOP.includes(leaf)) return "identity";
  if (path.some((segment) => segment.startsWith("__"))) return "control";
  if (isOwnVariable(path) && scopeName !== "runPrompt") return "data";
  if (isGlobal(path)) return "data";
  if (IDENTITY_LEAVES.includes(leaf)) return "identity";
  if (leaf === "step") return "control";
  const parent = path.at(-2);
  if (parent === "stack" && CONTROL_LEAVES_OF_STACK.includes(leaf)) return "control";
  if (isGuardField(path) && CONTROL_GUARD_FIELDS.includes(leaf)) return "control";
  const locals = path.indexOf("locals");
  if (locals >= 0 && scopeName === "runPrompt") {
    const local = path[locals + 1];
    if (local === "messagesJSON") {
      return LOOP_DATA_THREAD_LISTS.includes(path[locals + 2] ?? "") ? "data" : "control";
    }
    return LOOP_DATA_LOCALS.includes(local ?? "") ? "data" : "control";
  }
  return "data";
}

/** A frame's own local or argument: the leaf directly under `locals`
 *  or `args`. */
function isOwnVariable(path: string[]): boolean {
  const container = path.at(-2);
  return container === "locals" || container === "args";
}

/** A module's global: the leaf directly under a module in a globals
 *  store, the root's (`globals`) or a branch's (`globalsJSON`). */
function isGlobal(path: string[]): boolean {
  const owner = path.at(-4);
  return path.at(-3) === "store" && (owner === "globals" || owner === "globalsJSON");
}

function isGuardField(path: string[]): boolean {
  const list = path.at(-3);
  return list === "guards" || list === "inheritedTimeGuards";
}
