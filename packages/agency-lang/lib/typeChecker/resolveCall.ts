import type { FunctionDefinition, GraphNodeDefinition } from "../types.js";
import type { ImportedFunctionSignature } from "../compilationUnit.js";
import type { BuiltinSignature } from "./types.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";

/**
 * Names of Agency's *built-in* functions — language primitives with no
 * `def` source. Users cannot redefine these via `def` or `node`. Single
 * source of truth — imported by typeChecker/index.ts.
 *
 * Stdlib functions (print, read, fetch, etc.) are NOT here. They are
 * regular Agency code in stdlib/index.agency and users may shadow them.
 *
 * Built-ins fall into two parse-time categories:
 *
 *   1. Parsed as plain `functionCall`. Their typed signatures live in
 *      BUILTIN_FUNCTION_TYPES, so they resolve as `kind: "builtin"` before
 *      reaching the reserved-name fallback below. Listed here too as
 *      defense-in-depth (if a BUILTIN_FUNCTION_TYPES entry is ever removed,
 *      the reservation still prevents user redefinition).
 *
 *   2. Parsed as their own AST node — never reach functionCall handling:
 *
 *        schema(Type)  → SchemaExpression  — a language primitive that
 *          bridges *type space* and *value space*: the argument is a
 *          VariableType (not a value expression), and at runtime it
 *          constructs a zod schema from that type. Reserved here only so
 *          that `def schema()` can't create parse ambiguity. The typechecker
 *          currently synthesizes its result type as "any" — populating it
 *          with a structured `Schema<T>` type is future work.
 *
 *        interrupt ...  → InterruptStatement
 *        debugger       → DebuggerStatement
 */
export const RESERVED_FUNCTION_NAMES = new Set<string>([
  // Category 1 — parsed as `functionCall`, also in BUILTIN_FUNCTION_TYPES.
  "success",
  "failure",
  "isSuccess",
  "isFailure",
  "restore",
  "llm",
  "approve",
  "reject",
  "propagate",
  "checkpoint",
  "getCheckpoint",

  // Category 2 — parsed as their own AST node.
  "schema",
  "interrupt",
  "debugger",
]);

/**
 * Registry of JavaScript / Node.js globals that compiled Agency output
 * is allowed to call. Each entry is either:
 *   - kind: "callable"  — a function (sig is optional; populating it
 *                         later enables type-checking)
 *   - kind: "namespace" — an object with named members, each of which
 *                         is itself a JsRegistryEntry
 *
 * Phase 1 uses only the structure (existence checks). Phase 2 will
 * populate `sig` for entries we want type-checked; the typechecker
 * starts enforcing arity/types when `sig` is present.
 *
 * Names already supported natively by Agency (null, undefined) or rare
 * enough to defer (NaN, Infinity) are intentionally absent.
 */
export type JsRegistryEntry =
  | { kind: "callable"; sig?: BuiltinSignature }
  | { kind: "namespace"; members: Record<string, JsRegistryEntry> };

const callable = (sig?: BuiltinSignature): JsRegistryEntry => ({
  kind: "callable",
  sig,
});
const namespace = (
  members: Record<string, JsRegistryEntry>,
): JsRegistryEntry => ({
  kind: "namespace",
  members,
});

export const JS_GLOBALS: Record<string, JsRegistryEntry> = {
  // --- Flat callable globals ---
  parseInt: callable(),
  parseFloat: callable(),
  isNaN: callable(),
  isFinite: callable(),
  encodeURIComponent: callable(),
  decodeURIComponent: callable(),
  encodeURI: callable(),
  decodeURI: callable(),
  setTimeout: callable(),
  setInterval: callable(),
  clearTimeout: callable(),
  clearInterval: callable(),
  queueMicrotask: callable(),
  structuredClone: callable(),
  BigInt: callable(),
  Symbol: callable(),

  // --- Namespaces ---
  JSON: namespace({
    parse: callable(),
    stringify: callable(),
  }),
  Math: namespace({
    floor: callable(),
    ceil: callable(),
    round: callable(),
    abs: callable(),
    max: callable(),
    min: callable(),
    pow: callable(),
    sqrt: callable(),
    random: callable(),
    log: callable(),
    log2: callable(),
    log10: callable(),
    exp: callable(),
    sin: callable(),
    cos: callable(),
    tan: callable(),
    asin: callable(),
    acos: callable(),
    atan: callable(),
    atan2: callable(),
    sign: callable(),
    trunc: callable(),
    cbrt: callable(),
    hypot: callable(),
  }),
  Object: namespace({
    keys: callable(),
    values: callable(),
    entries: callable(),
    assign: callable(),
    freeze: callable(),
    fromEntries: callable(),
    getOwnPropertyNames: callable(),
    getPrototypeOf: callable(),
    setPrototypeOf: callable(),
  }),
  Array: namespace({
    isArray: callable(),
    from: callable(),
    of: callable(),
  }),
  String: namespace({
    fromCharCode: callable(),
    raw: callable(),
  }),
  Number: namespace({
    isInteger: callable(),
    isFinite: callable(),
    isNaN: callable(),
    isSafeInteger: callable(),
    parseFloat: callable(),
    parseInt: callable(),
  }),
  Date: namespace({
    now: callable(),
    parse: callable(),
    UTC: callable(),
  }),
  Promise: namespace({
    resolve: callable(),
    reject: callable(),
    all: callable(),
    allSettled: callable(),
    race: callable(),
    any: callable(),
  }),
  console: namespace({
    log: callable(),
    error: callable(),
    warn: callable(),
    info: callable(),
    debug: callable(),
    trace: callable(),
    table: callable(),
    dir: callable(),
    group: callable(),
    groupEnd: callable(),
    time: callable(),
    timeEnd: callable(),
    count: callable(),
  }),
  process: namespace({
    exit: callable(),
    nextTick: callable(),
    cwd: callable(),
    chdir: callable(),
  }),
  Buffer: namespace({
    from: callable(),
    alloc: callable(),
    allocUnsafe: callable(),
    concat: callable(),
    isBuffer: callable(),
    byteLength: callable(),
  }),
  // Error constructors — registered as callables so `Error("msg")` and
  // `TypeError("msg")` (callable form, equivalent to `new Error(...)` in JS)
  // don't false-positive. Phase 2 may add member entries (e.g. Error.captureStackTrace)
  // by promoting these to namespaces with `members` once we need them.
  Error: callable(),
  TypeError: callable(),
  RangeError: callable(),
  ReferenceError: callable(),
  SyntaxError: callable(),
};

/**
 * Walk a namespace path through `JS_GLOBALS`. Returns the leaf entry if
 * the full chain resolves, otherwise null.
 *
 * Examples:
 *   lookupJsMember(["JSON", "parse"])     → { kind: "callable", sig: undefined }
 *   lookupJsMember(["JSON", "banana"])    → null
 *   lookupJsMember(["NotAGlobal", "x"])   → null
 */
export function lookupJsMember(path: string[]): JsRegistryEntry | null {
  if (path.length === 0) return null;
  if (!Object.prototype.hasOwnProperty.call(JS_GLOBALS, path[0])) return null;
  let current: JsRegistryEntry | undefined = JS_GLOBALS[path[0]];
  for (let i = 1; i < path.length; i++) {
    if (!current || current.kind !== "namespace") return null;
    if (!Object.prototype.hasOwnProperty.call(current.members, path[i])) {
      return null;
    }
    current = current.members[path[i]];
  }
  return current ?? null;
}

type ResolveCallInput = {
  functionDefs: Record<string, FunctionDefinition>;
  nodeDefs: Record<string, GraphNodeDefinition>;
  importedFunctions: Record<string, ImportedFunctionSignature>;
  /** Names imported via `import node { ... } from "..."`. */
  importedNodeNames: readonly string[];
  scopeHas: (name: string) => boolean;
};

/**
 * Tagged union describing where a call name resolved to. The diagnostic
 * only cares whether `kind === "unresolved"`; the other kinds are
 * informational so future analyses can distinguish "user code" from
 * "language built-in" from "JS interop" without re-running the lookup.
 *
 *   def           — locally-defined `def` or `node` in this file.
 *   imported      — function or node imported from another `.agency` file
 *                   (`import { foo } from "./other.agency"` or
 *                   `import node { foo } from "./other.agency"`).
 *   builtin       — has a typed signature in `BUILTIN_FUNCTION_TYPES`.
 *                   Includes both true language primitives (`success`,
 *                   `failure`, `llm`, `approve`, `reject`, `propagate`,
 *                   `checkpoint`, `getCheckpoint`, `restore`,
 *                   `isSuccess`, `isFailure`) AND stdlib functions whose
 *                   signatures are hardcoded for typechecker convenience
 *                   (`print`, `fetch`, `read`, etc. — see the NOTE in
 *                   `builtins.ts` flagging this as tech debt).
 *   reserved      — listed in `RESERVED_FUNCTION_NAMES` but NOT in
 *                   `BUILTIN_FUNCTION_TYPES`. In practice these are the
 *                   three names parsed into their own AST node type
 *                   (`schema` → SchemaExpression, `interrupt` →
 *                   InterruptStatement, `debugger` → DebuggerStatement),
 *                   so they don't normally reach this function as a
 *                   `functionCall`. Defensive — if the parser ever
 *                   emits one anyway, we don't want a false positive.
 *   scopeBinding  — bound in the local scope (lambda, `partial`,
 *                   `for` variable, etc.).
 *   jsGlobal      — flat callable JS global (`parseInt`, `setTimeout`).
 *                   Namespace member calls like `JSON.parse(...)` are
 *                   handled separately via `lookupJsMember`.
 *   unresolved    — none of the above. The diagnostic emits.
 */
export type CallResolution =
  | { kind: "def" }
  | { kind: "imported" }
  | { kind: "builtin" }
  | { kind: "reserved" }
  | { kind: "scopeBinding" }
  | { kind: "jsGlobal" }
  | { kind: "unresolved" };

/**
 * Own-property check — `name in obj` walks the prototype chain, so names
 * like "toString" / "constructor" would falsely resolve against any
 * Record. Use this for the registries below (which are plain objects).
 */
const has = (obj: object, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, name);

/**
 * Resolution order matters:
 *
 *   1. Local `def`/`node`             — user code wins.
 *   2. Imported from another file     — cross-file `def`/`node`.
 *   3. `BUILTIN_FUNCTION_TYPES`       — language primitives + hardcoded
 *                                       stdlib signatures.
 *   4. `RESERVED_FUNCTION_NAMES`      — defensive fallback for the three
 *                                       names parsed into their own AST
 *                                       node type (schema / interrupt /
 *                                       debugger). Should never fire in
 *                                       practice.
 *   5. Local scope binding            — lambdas, `partial`, `for` vars.
 *   6. Flat JS global callable        — parseInt, setTimeout, etc.
 *   7. Otherwise: unresolved.
 *
 * Imports take precedence over builtins so a real stdlib `def print()`
 * shadows the hardcoded BUILTIN_FUNCTION_TYPES signature when the
 * SymbolTable wires it through. See the NOTE in `builtins.ts`.
 */
export function resolveCall(
  name: string,
  input: ResolveCallInput,
): CallResolution {
  if (has(input.functionDefs, name) || has(input.nodeDefs, name))
    return { kind: "def" };
  if (has(input.importedFunctions, name)) return { kind: "imported" };
  if (input.importedNodeNames.includes(name)) return { kind: "imported" };
  if (has(BUILTIN_FUNCTION_TYPES, name)) return { kind: "builtin" };
  if (RESERVED_FUNCTION_NAMES.has(name)) return { kind: "reserved" };
  if (input.scopeHas(name)) return { kind: "scopeBinding" };
  if (has(JS_GLOBALS, name)) {
    const jsEntry = JS_GLOBALS[name];
    if (jsEntry.kind === "callable") return { kind: "jsGlobal" };
  }
  return { kind: "unresolved" };
}
