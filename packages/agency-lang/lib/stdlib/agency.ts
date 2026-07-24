import { compileSource, typeCheckSource, getEffectsFromSource, TypeCheckReport } from "../compiler/compile.js";
import { writeFileSync, readFileSync, realpathSync, existsSync } from "fs";
import { resolve, sep } from "path";
import { parseAgency, replaceBlankLines } from "../parser.js";
import { AgencyGenerator, generateAgency } from "../backends/agencyGenerator.js";
import { TypescriptPreprocessor } from "../preprocessors/typescriptPreprocessor.js";
import { walkNodesArray } from "../utils/node.js";
import { docStringText } from "../utils/docStringText.js";
import { declaredName } from "../types/hole.js";
import { deepCopy } from "../utils.js";
import {
  ImportKind,
  ImportPolicy,
  isImportAllowed,
} from "../importPaths.js";
import type { AgencyMultiLineComment, AgencyProgram, AgencyNode } from "../types.js";
import type { ImportStatement } from "../types/importStatement.js";
import { _write } from "./builtins.js";
import {
  VALID_CALLBACK_NAMES,
  type CallbackName,
} from "../types/function.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { AgencyFunction } from "../runtime/agencyFunction.js";

const VALID_CALLBACK_NAME_SET: ReadonlySet<string> = new Set(VALID_CALLBACK_NAMES);

/**
 * Register a scoped callback for the dynamic extent of the caller's function
 * or node. Implementation backing for `callback(name, fn)` in std::agency.
 *
 * Frame targeting:
 *   - At top level (inside `__initializeGlobals`, before any node frame is
 *     pushed) — route to `ctx.topLevelCallbacks`, which lives on the
 *     execution context for the whole run.
 *   - Otherwise — push onto the caller's stack frame, which auto-cleans up
 *     when the caller's frame pops.
 *
 * NOTE on the AgencyFunction wrapping: this function needs access to the
 * runtime state (to walk the stateStack and find the caller's frame), and
 * the only way a TS-implemented stdlib export receives that state is by
 * being wrapped as an AgencyFunction. `__call`'s plain-function branch
 * silently drops the state argument; the AgencyFunction branch routes
 * through `invoke()`, which passes state as the last positional arg to the
 * underlying TS function. See `_run` in `lib/runtime/ipc.ts` for the
 * established pattern.
 */
// Exported as `_callbackImpl` so unit tests can call it directly without
// going through the AgencyFunction wrapper / `invoke()` indirection.
// Direct JS callers must wrap their invocation in `runInTestContext` so
// `getRuntimeContext()` finds an active ALS frame.
export function _callbackImpl(name: string, fn: unknown): void {
  if (!VALID_CALLBACK_NAME_SET.has(name)) {
    throw new Error(
      `Unknown callback '${name}'. Valid: ${VALID_CALLBACK_NAMES.join(", ")}`,
    );
  }
  if (typeof fn !== "function" && !AgencyFunction.isAgencyFunction(fn)) {
    throw new Error(
      `callback('${name}', fn): fn must be a function, got ${fn === null ? "null" : typeof fn}`,
    );
  }
  const { ctx } = getRuntimeContext();
  // Top-level: we're inside __initializeGlobals. The only frame on the stack
  // is `callback`'s own (or none, defensively). There is no caller frame
  // that survives past init, so route to ctx.topLevelCallbacks.
  if (ctx.stateStack.isGlobalContext()) {
    ctx.topLevelCallbacks.push({ name, fn });
    return;
  }
  ctx.stateStack.callerFrame().addScopedCallback(name as CallbackName, fn);
}

export const _callback = new AgencyFunction({
  name: "_callback",
  module: "agency-lang/stdlib-lib/agency.js",
  fn: _callbackImpl,
  params: [
    { name: "name", hasDefault: false, defaultValue: undefined, variadic: false },
    { name: "fn", hasDefault: false, defaultValue: undefined, variadic: false },
  ],
  toolDefinition: null,
});

function compileToProgram(source: string): { moduleId: string; code: string } {
  const result = compileSource(source, {
    typechecker: { enabled: true },
    imports: { allowKinds: ["stdlib"] },
  });

  if (!result.success) {
    throw new Error(result.errors.join("\n"));
  }

  // The compiled JS travels IN the CompiledProgram value so that any
  // checkpoint containing it is fully self-contained — the code is
  // generated at runtime and cannot be assumed present on disk at resume
  // time. `_run` materializes it to .agency-tmp/ at fork time.
  return { moduleId: result.moduleId, code: result.code };
}

export function _compile(source: string): { moduleId: string; code: string } {
  return compileToProgram(source);
}

// Resolve `filename` against `dir`, requiring the result to live strictly
// inside `dir` after symlinks are collapsed. Used by _compileFile,
// _typecheckFile, and _formatFile to share one sandbox boundary.
//
// SECURITY: A naive `path.resolve(dir, filename)` is unsafe in two ways:
//   1. If `filename` is absolute (e.g. "/etc/passwd"), `resolve` ignores
//      `dir` entirely.
//   2. `filename` may contain `..` segments that walk out of `dir`.
// We defend against both by realpath-ing the resolved file and checking
// it lives strictly inside the realpath-ed `dir`. realpath also collapses
// symlinks, so a symlink planted inside `dir` that points outside cannot
// be used as an escape hatch. The trailing `+ sep` on the prefix
// prevents a sibling directory (e.g. `/safedir-evil/`) from passing the
// startsWith check by sharing the same prefix string.
//
// When `mustExist` is false, the target file is allowed to not exist yet
// (used by callers that are about to create the file). In that mode we
// realpath the directory but only lexically resolve the file path —
// symlinks INSIDE `dir` are not followed on the missing-target branch,
// so if you let the user create a symlink and then write to it, that's
// on you. For overwrite of an EXISTING symlink the realpath check still
// applies because we hit the existing-target branch.
export function resolveInSandbox(
  dir: string,
  filename: string,
  opts: { mustExist?: boolean } = {},
): string {
  const mustExist = opts.mustExist ?? true;
  const sandboxRoot = realpathSync(resolve(dir));
  const resolved = resolve(sandboxRoot, filename);
  // Realpath the target whenever it exists so symlinks get collapsed and
  // can't punch out of the sandbox. The only branch that skips realpath
  // is "the target doesn't exist yet AND the caller said that's fine" —
  // used by write-style callers (writeAST) that are about to create the
  // file.
  let target: string;
  if (mustExist || existsSync(resolved)) {
    target = realpathSync(resolved);
  } else {
    target = resolved;
  }
  if (!target.startsWith(sandboxRoot + sep)) {
    throw new Error(
      `Sandbox violation: '${filename}' resolves to '${target}', which is outside the sandbox dir '${sandboxRoot}'.`,
    );
  }
  return target;
}

// Read an agency source file from disk and compile it under the same
// stdlib-only restriction as _compile. The (dir, filename) split mirrors
// std::read / std::write so callers can use partial application to bind
// `dir` to a sandbox path: `runFile.bind(dir: "/safe/dir")`.
export function _compileFile(
  dir: string,
  filename: string,
): { moduleId: string; code: string } {
  const source = readFileSync(resolveInSandbox(dir, filename), "utf-8");
  return compileToProgram(source);
}

/** The current process's subprocess nesting depth (0 = root). Backs the
 * `depth` field in std::run gate interrupt data — `run()` reports the
 * PROSPECTIVE child depth as `_subprocessDepth() + 1` so handlers can
 * reject by depth. Also readable from TS via `agency.ctx().subprocessDepth`. */
export function _subprocessDepth(): number {
  return getRuntimeContext().ctx.subprocessDepth ?? 0;
}

export function _typecheck(source: string): TypeCheckReport {
  return typeCheckSource(source);
}

export function _getEffects(source: string): Record<string, string[]> {
  return getEffectsFromSource(source);
}

// ---------------------------------------------------------------------------
// Reify: describe a module's exports as data
// ---------------------------------------------------------------------------

export type ExportInfo = {
  name: string;
  kind: "def" | "node" | "type";
  signature: string;
  docstring: string | null;
  effects: string[];
  destructive: boolean;
  idempotent: boolean;
};

export type ModuleInfo = {
  description: string | null;
  exports: ExportInfo[];
};

/** One ExportInfo per EXPORTED top-level def, node, and type alias, in
 *  source order. Underscore-prefixed exports are omitted — the same rule
 *  `agency doc` applies: they are exported for the compiler's sake
 *  (lowering targets like `_guard`), not for callers. Effects come from
 *  the same transitive analysis as _getEffects, sentinel included. */
export function _describe(source: string): ModuleInfo {
  const program = parseSource(source);
  // Doc comments live as loose comment nodes until attachment — the same
  // pass `agency doc` runs. It hoists the @module comment onto
  // program.docComment and pins each doc comment to its declaration.
  new TypescriptPreprocessor(program, {}).attachDocComments();
  const effects = getEffectsFromSource(source);
  const generator = new AgencyGenerator();
  const exports: ExportInfo[] = [];
  for (const node of program.nodes) {
    const info = exportInfoFor(node, generator, effects);
    if (info) exports.push(info);
  }
  return {
    description: moduleDocText(program.docComment),
    exports,
  };
}

/** The module doc comment's text, with the doc-generator @summary marker
 *  dropped — the marker structures `agency doc` pages, not prose. */
function moduleDocText(comment: AgencyMultiLineComment | undefined): string | null {
  if (!comment) return null;
  const text = comment.content.trim().replace(/^@summary\s+/, "");
  return text === "" ? null : text;
}

function exportInfoFor(
  node: AgencyNode,
  generator: AgencyGenerator,
  effects: Record<string, string[]>,
): ExportInfo | null {
  if (node.type === "function" && node.exported) {
    const name = declaredName(node.functionName);
    if (name.startsWith("_")) return null;
    return {
      name,
      kind: "def",
      signature: generator.signatureOf(node),
      docstring: node.docString ? docStringText(node.docString) : null,
      effects: effects[name] ?? [],
      destructive: node.markers?.destructive === true,
      idempotent: node.markers?.idempotent === true,
    };
  }
  if (node.type === "graphNode" && node.exported) {
    const name = declaredName(node.nodeName);
    if (name.startsWith("_")) return null;
    return {
      name,
      kind: "node",
      signature: generator.signatureOf(node),
      docstring: node.docString ? docStringText(node.docString) : null,
      effects: effects[name] ?? [],
      // Nodes carry no tool markers; only defs can be declared
      // destructive or idempotent.
      destructive: false,
      idempotent: false,
    };
  }
  if (node.type === "typeAlias" && node.exported) {
    if (node.aliasName.startsWith("_")) return null;
    // The canonical printer emits the full declaration. The doc comment
    // is already carried in `docstring` and the export keyword is
    // caller-visible noise, so both are kept out of the signature — the
    // same shape def/node signatures have (no keywords, no docs).
    const bare = { ...node, docComment: undefined };
    const printed = generateAgency({ type: "agencyProgram", nodes: [bare] })
      .trim()
      .replace(/^export\s+/, "");
    return {
      name: node.aliasName,
      kind: "type",
      signature: printed,
      docstring: node.docComment?.content.trim() || null,
      effects: [],
      destructive: false,
      idempotent: false,
    };
  }
  return null;
}

// The real file path is handed to the type-checker so relative imports in
// `source` resolve against `dir` (transitive imports may still walk outside
// `dir` — typechecking is read-only so this is intentional).
export function _typecheckFile(dir: string, filename: string): TypeCheckReport {
  const target = resolveInSandbox(dir, filename);
  return typeCheckSource(readFileSync(target, "utf-8"), target);
}

// ---------------------------------------------------------------------------
// AST + formatter primitives
// ---------------------------------------------------------------------------
//
// _parseAST / _writeAST / _format / _formatFile / _walkAST and friends are
// all centered on a single principle: there is exactly one AST → source
// path (`generateAgency`) and exactly one source → AST path
// (`parseAgency` with `applyTemplate: false, lower: false`). That
// combination matches what `pnpm run fmt` does and is what makes
// round-tripping work: patterns aren't lowered to their desugared form,
// so the generator can print them back as patterns.

function parseSource(source: string): AgencyProgram {
  // Match the format path: don't apply the template (we want source line
  // numbers untouched) and don't lower patterns (the generator needs to
  // print them back as patterns). `replaceBlankLines` preserves blank
  // lines through the parser as it does in the CLI format command.
  const result = parseAgency(replaceBlankLines(source), {}, false, false);
  if (!result.success) {
    throw new Error(result.message ?? "Failed to parse Agency source");
  }
  return result.result;
}

export function _parseAST(source: string): AgencyProgram {
  return parseSource(source);
}

export async function _writeAST(
  ast: AgencyProgram,
  dir: string,
  filename: string,
  overwrite: boolean,
): Promise<boolean> {
  // Delegate to _write so all writes share path resolution, sandbox
  // containment, and existence checks. `overwrite: false` maps to
  // create-only mode.
  const source = generateAgency(ast);
  const mode = overwrite ? "overwrite" : "create-only";
  return _write(dir, filename, source, mode);
}

export function _format(source: string): string {
  return generateAgency(_parseAST(source));
}

export function _formatFile(dir: string, filename: string): boolean {
  // formatFile *requires* the file to exist — it reads then writes.
  // Use the existing-target branch (mustExist: true) so symlinks get
  // realpath-collapsed before we touch the file.
  const target = resolveInSandbox(dir, filename, { mustExist: true });
  const source = readFileSync(target, "utf-8");
  const formatted = generateAgency(_parseAST(source));
  // Skip the write if formatting is a no-op — avoids touching mtime
  // when nothing actually changed. Matches Prettier / rustfmt behavior.
  if (formatted !== source) {
    writeFileSync(target, formatted, "utf-8");
  }
  return true;
}

// ---------------------------------------------------------------------------
// walkAST
// ---------------------------------------------------------------------------

export type WalkASTVisit = {
  node: AgencyNode;
  ancestors: AgencyNode[];
};

// Deep-clone the AST, enumerate every visit (pre-order) into a flat array,
// and hand both back. The Agency wrapper iterates `visits` calling the
// user's visitor; the visits hold references into `clone`, so in-place
// mutation in the visitor lands in `clone` and is returned. We reuse the
// existing `walkNodesArray` from lib/utils/node.ts as the single source
// of truth for traversal — when the parser learns a new node kind, this
// picks it up for free.
//
// SEMANTICS: The visit list is built BEFORE the visitor runs. If the
// visitor mutates a parent during the walk, the children that were
// already buffered into the visit list are still walked (against the
// pre-mutation state). This is documented in walkAST's docstring.
export function _walkAST(ast: AgencyProgram): {
  clone: AgencyProgram;
  visits: WalkASTVisit[];
} {
  const clone = deepCopy(ast);
  const visits: WalkASTVisit[] = [];
  for (const { node, ancestors } of walkNodesArray(clone.nodes)) {
    visits.push({ node, ancestors: ancestors as AgencyNode[] });
  }
  return { clone, visits };
}

// ---------------------------------------------------------------------------
// Convenience queries on source
// ---------------------------------------------------------------------------
//
// Source-string-in helpers for the common "I just want the imports / the
// function definitions / etc. out of this file" case. All three
// convenience wrappers delegate to _getNodesOfType — do NOT reimplement
// the parse-and-walk dance per wrapper.

export function _getNodesOfType(
  source: string,
  types: string[],
): AgencyNode[] {
  const ast = _parseAST(source);
  const wanted = new Set(types);
  return walkNodesArray(ast.nodes)
    .map((v) => v.node)
    .filter((n) => wanted.has(n.type));
}

// _getImports / _getFunctions / _getGraphNodes are convenience wrappers
// around _getNodesOfType. They live in stdlib/agency.agency as Agency
// functions that call getNodesOfType directly — no need for TS stubs.

// ---------------------------------------------------------------------------
// filterImports
// ---------------------------------------------------------------------------

export function _filterImports(
  source: string,
  allowedPackages: string[],
  excludedPackages: string[],
  allowKinds: string[],
  excludeKinds: string[],
): { source: string; filtered: boolean } {
  const ast = _parseAST(source);
  // Unknown kind strings in allowKinds/excludeKinds are silently ignored —
  // `importKind` only ever returns one of the four canonical strings, so
  // a bogus entry like "fish" can never match. The cast just satisfies
  // the type system.
  const policy: ImportPolicy = {
    allowedPackages,
    excludedPackages,
    allowKinds: allowKinds as ImportKind[],
    excludeKinds: excludeKinds as ImportKind[],
  };
  const originalCount = ast.nodes.length;
  ast.nodes = ast.nodes.filter(
    (n) =>
      !(n.type === "importStatement") ||
      isImportAllowed((n as ImportStatement).modulePath, policy),
  );
  const filtered = ast.nodes.length !== originalCount;
  return { source: generateAgency(ast), filtered };
}
