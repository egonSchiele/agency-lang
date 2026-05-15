import type { FunctionDefinition, GraphNodeDefinition } from "../types.js";
import type { ImportedFunctionSignature } from "../compilationUnit.js";
import type { BuiltinSignature } from "./types.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import {
  ANY_T,
  BOOLEAN_T,
  NUMBER_T,
  STRING_T,
} from "./primitives.js";

const stringArray = { type: "arrayType", elementType: STRING_T } as const;
const anyArray = { type: "arrayType", elementType: ANY_T } as const;

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

// Common single-number-arg, returns-number signature (Math.floor / ceil / round / abs / sqrt / sign / trunc / cbrt etc.).
const numToNum: BuiltinSignature = { params: [NUMBER_T], returnType: NUMBER_T };

export const JS_GLOBALS: Record<string, JsRegistryEntry> = {
  // --- Flat callable globals ---
  // `parseInt` accepts an optional radix; we accept a 1-or-2-arg call against
  // (string|number, number) which covers the realistic cases without false
  // positives on numeric inputs (`parseInt(0.5)`, `parseInt(1, 2)`).
  parseInt: callable({
    params: [{ type: "unionType", types: [STRING_T, NUMBER_T] }, NUMBER_T],
    minParams: 1,
    returnType: NUMBER_T,
  }),
  parseFloat: callable({
    params: [{ type: "unionType", types: [STRING_T, NUMBER_T] }],
    returnType: NUMBER_T,
  }),
  isNaN: callable({ params: ["any"], returnType: BOOLEAN_T }),
  isFinite: callable({ params: ["any"], returnType: BOOLEAN_T }),
  encodeURIComponent: callable({ params: [STRING_T], returnType: STRING_T }),
  decodeURIComponent: callable({ params: [STRING_T], returnType: STRING_T }),
  encodeURI: callable({ params: [STRING_T], returnType: STRING_T }),
  decodeURI: callable({ params: [STRING_T], returnType: STRING_T }),
  setTimeout: callable(),
  setInterval: callable(),
  clearTimeout: callable(),
  clearInterval: callable(),
  queueMicrotask: callable(),
  structuredClone: callable({ params: ["any"], returnType: "any" }),
  BigInt: callable(),
  Symbol: callable(),

  // --- Namespaces ---
  JSON: namespace({
    parse: callable({ params: [STRING_T], returnType: "any" }),
    // JSON.stringify(value, replacer?, space?). Replacer can be many things —
    // type as `any` to avoid false positives.
    stringify: callable({
      params: ["any", "any", { type: "unionType", types: [STRING_T, NUMBER_T] }],
      minParams: 1,
      returnType: STRING_T,
    }),
  }),
  Math: namespace({
    floor: callable(numToNum),
    ceil: callable(numToNum),
    round: callable(numToNum),
    abs: callable(numToNum),
    sqrt: callable(numToNum),
    sign: callable(numToNum),
    trunc: callable(numToNum),
    cbrt: callable(numToNum),
    log: callable(numToNum),
    log2: callable(numToNum),
    log10: callable(numToNum),
    exp: callable(numToNum),
    sin: callable(numToNum),
    cos: callable(numToNum),
    tan: callable(numToNum),
    asin: callable(numToNum),
    acos: callable(numToNum),
    atan: callable(numToNum),
    // Variadic — keep arity loose so `Math.max(1, 2, 3)` doesn't false-positive.
    max: callable({ params: [], restParam: NUMBER_T, returnType: NUMBER_T }),
    min: callable({ params: [], restParam: NUMBER_T, returnType: NUMBER_T }),
    pow: callable({ params: [NUMBER_T, NUMBER_T], returnType: NUMBER_T }),
    atan2: callable({ params: [NUMBER_T, NUMBER_T], returnType: NUMBER_T }),
    hypot: callable({ params: [], restParam: NUMBER_T, returnType: NUMBER_T }),
    random: callable({ params: [], returnType: NUMBER_T }),
  }),
  Object: namespace({
    keys: callable({ params: ["any"], returnType: stringArray }),
    values: callable({ params: ["any"], returnType: anyArray }),
    entries: callable({ params: ["any"], returnType: anyArray }),
    fromEntries: callable({ params: [anyArray], returnType: "any" }),
    assign: callable(),
    freeze: callable({ params: ["any"], returnType: "any" }),
    getOwnPropertyNames: callable({ params: ["any"], returnType: stringArray }),
    getPrototypeOf: callable({ params: ["any"], returnType: "any" }),
    setPrototypeOf: callable(),
  }),
  Array: namespace({
    isArray: callable({ params: ["any"], returnType: BOOLEAN_T }),
    from: callable(),
    of: callable(),
  }),
  String: namespace({
    fromCharCode: callable({ params: [], restParam: NUMBER_T, returnType: STRING_T }),
    raw: callable(),
  }),
  Number: namespace({
    isInteger: callable({ params: ["any"], returnType: BOOLEAN_T }),
    isFinite: callable({ params: ["any"], returnType: BOOLEAN_T }),
    isNaN: callable({ params: ["any"], returnType: BOOLEAN_T }),
    isSafeInteger: callable({ params: ["any"], returnType: BOOLEAN_T }),
    parseFloat: callable({
      params: [{ type: "unionType", types: [STRING_T, NUMBER_T] }],
      returnType: NUMBER_T,
    }),
    parseInt: callable({
      params: [{ type: "unionType", types: [STRING_T, NUMBER_T] }, NUMBER_T],
      minParams: 1,
      returnType: NUMBER_T,
    }),
  }),
  Date: namespace({
    now: callable({ params: [], returnType: NUMBER_T }),
    parse: callable({ params: [STRING_T], returnType: NUMBER_T }),
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
  // console.* — variadic, intentionally untyped so `console.log(1, 2, 3)` etc.
  // never false-positives.
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
 *                   True language primitives only: `success`, `failure`,
 *                   `llm`, `approve`, `reject`, `propagate`, `checkpoint`,
 *                   `getCheckpoint`, `restore`, `isSuccess`, `isFailure`.
 *                   Stdlib functions (`print`, `fetch`, `read`, etc.)
 *                   resolve as `imported` instead, via the auto-injected
 *                   `import { ... } from "std::index"` statement.
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
 *   2. Imported from another file     — cross-file `def`/`node`. Stdlib
 *                                       functions (print, fetch, read,
 *                                       …) resolve here via the
 *                                       auto-injected std::index import.
 *   3. `BUILTIN_FUNCTION_TYPES`       — Agency language primitives.
 *   4. `RESERVED_FUNCTION_NAMES`      — defensive fallback for the three
 *                                       names parsed into their own AST
 *                                       node type (schema / interrupt /
 *                                       debugger). Should never fire in
 *                                       practice.
 *   5. Local scope binding            — lambdas, `partial`, `for` vars.
 *   6. Flat JS global callable        — parseInt, setTimeout, etc.
 *   7. Otherwise: unresolved.
 */
/**
 * Inputs for {@link isJsGlobalBase}. The shape mirrors {@link ResolveCallInput}
 * but adds class and import-node bookkeeping so user definitions of
 * `JSON` / `Math` / etc. (via `node`, `import node`, or `class`) cleanly
 * opt out of JS_GLOBALS validation.
 */
export type ShadowingInput = {
  scope: { has(name: string): boolean };
  functionDefs: object;
  nodeDefs: object;
  importedFunctions: object;
  importedNodeNames: readonly string[];
  classNames: object;
};

/**
 * `true` only when `name` resolves to a JS global *and* nothing user-defined
 * shadows it. Use this to gate JS-namespace member validation (e.g.
 * `JSON.parse(...)`) and avoid checking against `JS_GLOBALS` when the user
 * has their own `node JSON()` / `class JSON` / `let JSON = …`.
 */
export function isJsGlobalBase(name: string, input: ShadowingInput): boolean {
  if (!has(JS_GLOBALS, name)) return false;
  if (input.scope.has(name)) return false;
  if (has(input.functionDefs, name)) return false;
  if (has(input.nodeDefs, name)) return false;
  if (has(input.importedFunctions, name)) return false;
  if (input.importedNodeNames.includes(name)) return false;
  if (has(input.classNames, name)) return false;
  return true;
}

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
