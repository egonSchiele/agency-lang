import { SymbolTable } from "@/symbolTable.js";
import type { CompilationUnit } from "@/compilationUnit.js";
import { declaredName } from "../types/hole.js";
import { AgencyConfig } from "@/config.js";
import { AgencyGenerator, generateAgency } from "@/backends/agencyGenerator.js";
import { readFile } from "./commands.js";
import { parseAgency } from "../parser.js";
import { hashFile } from "@/compiler/buildManifest.js";
import { findRecursively } from "@/utils/findRecursively.js";
import { variableTypeToString } from "@/backends/typescriptGenerator/typeToString.js";
import { AgencyMultiLineComment, AgencyProgram, Assignment } from "@/types.js";
import type { Tag } from "@/types/tag.js";
import { TypeAlias, VariableType } from "@/types/typeHints.js";
import { EffectDeclaration } from "@/types/effectDeclaration.js";
import { FunctionDefinition, FunctionParameter } from "@/types/function.js";
import { GraphNodeDefinition } from "@/types/graphNode.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit, GLOBAL_SCOPE_KEY } from "@/compilationUnit.js";
import { typeCheck } from "@/typeChecker/index.js";
import type { InterruptEffect } from "@/symbolTable.js";
import { heading, codeFence, bold, markdownTable, section } from "@/utils/markdown.js";
import { docStringText } from "@/utils/docStringText.js";
import { HIDDEN_TAG, isHidden } from "@/utils/hiddenTag.js";
import {
  OwnedPathError,
  acquireDocLock,
  buildDocFreshnessContext,
  buildDocLedgerEntry,
  captureDepSnapshot,
  docRenderKey,
  isDocEntryFresh,
  isSafeSourceRel,
  loadDocLedger,
  outputPathFor,
  releaseDocLock,
  resolveOwnedOutputPath,
  saveDocLedger,
  type DocLedgerEntry,
} from "./docLedger.js";
import * as fs from "fs";
import * as path from "path";

// Maps a symbol name to the relative .md path where it's documented
type SymbolRegistry = Record<string, string>;

type DocContext = {
  baseUrl?: string;
  sourceRelPath?: string;
  symbolRegistry: SymbolRegistry;
  currentMdPath?: string;
  config: AgencyConfig;
  /** Built on first use, PER PAGE (each page gets a fresh DocContext). */
  symbolTable?: SymbolTable;
  /** When set, formatTypeLinked records every registry lookup it makes:
   *  name → target md path, or null for "rendered unlinked". This is the
   *  cache's evidence for re-checking links against next run's registry. */
  linkRecorder?: Record<string, string | null>;
};

/** A parse failure inside a doc run. Thrown (never process.exit) so the
 *  lock's finally can unwind — commands.ts's exiting parse() would leave
 *  a permanent stale lock on an ordinary syntax error. */
class DocParseError extends Error {}

function parseDocSource(contents: string, config: AgencyConfig): AgencyProgram {
  const result = parseAgency(contents, config, true);
  if (!result.success) {
    throw new DocParseError(
      result.message
        ? `Failed to parse Agency program: ${result.message}`
        : `Failed to parse Agency program. ${contents.slice(0, 400)}`,
    );
  }
  return result.result;
}

export function generateDoc(
  config: AgencyConfig,
  inputPath: string,
  outputDir: string,
  ignoreDirs: string[] = [],
  baseUrlOverride?: string,
): void {
  const rawBaseUrl = baseUrlOverride || config.doc?.baseUrl;
  const baseUrl = rawBaseUrl?.replace(/\/+$/, "");

  // BOTH branches lock: single-file mode bypasses the cache (no ledger,
  // no freshness, no reconciliation) but writes into the same physical
  // output directory, so it must not interleave with a directory run.
  fs.mkdirSync(outputDir, { recursive: true });
  const outDirReal = fs.realpathSync(outputDir);
  const lock = acquireDocLock(outDirReal);
  try {
    if (fs.statSync(inputPath).isDirectory()) {
      generateDocDirectory(config, inputPath, outDirReal, ignoreDirs, baseUrl);
    } else {
      const baseName = path.basename(inputPath).replace(/\.agency$/, ".md");
      // Same owned-output boundary as directory mode: without it, a
      // symlink planted at out/<name>.md would be followed and an
      // external file overwritten.
      const resolved = resolveOwnedOutputPath(outDirReal, baseName);
      if (resolved.leafIsSymlink) {
        throw new OwnedPathError(`refusing to write documentation through a symlink: ${baseName}`);
      }
      const program = preprocessProgram(parseDocSource(readFile(inputPath), config), config);
      generateDocForFile(
        inputPath,
        resolved.abs,
        {
          baseUrl,
          sourceRelPath: path.basename(inputPath),
          symbolRegistry: {},
          config,
        },
        program,
      );
    }
  } catch (e) {
    if (e instanceof DocParseError) {
      // process.exit skips finally, so release explicitly first
      // (releasing twice is a token-checked no-op).
      releaseDocLock(lock);
      console.error(e.message);
      process.exit(1);
    }
    throw e; // finally releases on this path
  } finally {
    releaseDocLock(lock);
  }
}

/**
 * Directory mode with the incremental cache. The flow's invariants:
 *
 *  - Freshness and ownership are separate evidence. Identity or
 *    render-key changes mark every page stale but RETAIN prior entries —
 *    they are what authorizes deleting obsolete pages. Only a ledger that
 *    failed validation (authority=false) deletes nothing.
 *  - The registry is rebuilt every run in TRAVERSAL ORDER (collisions are
 *    last-writer-wins; fresh files contribute their cached symbols, stale
 *    files their parsed ones). Never sort the traversal.
 *  - Rendering is unchanged from the uncached path: each stale page goes
 *    through today's generateDocForFile with its own per-page context
 *    (and thus its own symbol table). Fresh pages build nothing.
 */
function generateDocDirectory(
  config: AgencyConfig,
  inputPath: string,
  outDirReal: string,
  ignoreDirs: string[],
  baseUrl: string | undefined,
): void {
  const inputDirReal = fs.realpathSync(path.resolve(inputPath));
  const { ledger: prior, authority } = loadDocLedger(outDirReal);
  const renderKey = docRenderKey(config, baseUrl ?? "");
  const sortedIgnore = [...ignoreDirs].sort();
  const identityMatches =
    prior !== null &&
    prior.identity.inputDir === inputDirReal &&
    sameStringList(prior.identity.ignoreDirs, sortedIgnore);
  const allStale = !authority || !identityMatches || prior!.renderKey !== renderKey;

  const files = [...findRecursively(inputDirReal, ".agency", [], ignoreDirs)];
  const ctx = buildDocFreshnessContext(inputDirReal, outDirReal);

  type FileInfo = { filePath: string; rel: string; mdRelPath: string; fresh: boolean };
  const infos: FileInfo[] = files.map(({ path: filePath }) => {
    const rel = path.relative(inputDirReal, filePath);
    // Traversal from the realpath'd root cannot produce escaping keys,
    // but the safety predicate stays load-bearing: an unsafe rel is
    // rendered without ever becoming a ledger key.
    const safe = isSafeSourceRel(rel);
    const entry = safe ? prior?.entries[rel] : undefined;
    return {
      filePath,
      rel,
      mdRelPath: rel.replace(/\.agency$/, ".md"),
      fresh: !allStale && entry !== undefined && isDocEntryFresh(rel, entry, ctx),
    };
  });

  // Pass 1 — the symbol registry, in traversal order. Fresh files
  // contribute their cached registrySymbols without being parsed; that is
  // the cache's entire point (parsing is ~80% of a doc run). The source
  // hash is captured AT PARSE TIME so the entry builder can detect an
  // editor save landing mid-render and refuse to cache the stale page.
  const symbolRegistry: SymbolRegistry = {};
  const parsedPrograms = new Map<string, AgencyProgram>();
  const sourceHashAtParse = new Map<string, string>();
  const parseFor = (filePath: string): AgencyProgram => {
    sourceHashAtParse.set(filePath, hashFile(filePath) ?? "");
    const program = preprocessProgram(parseDocSource(readFile(filePath), config), config);
    parsedPrograms.set(filePath, program);
    return program;
  };
  for (const info of infos) {
    if (info.fresh) {
      for (const name of prior!.entries[info.rel].registrySymbols) {
        symbolRegistry[name] = info.mdRelPath;
      }
    } else {
      for (const name of extractRegistrySymbols(parseFor(info.filePath))) {
        symbolRegistry[name] = info.mdRelPath;
      }
    }
  }

  // Link re-check: a fresh page stays fresh only if every registry lookup
  // it recorded still answers identically (including "still unresolved"
  // for null records). This is what makes cross-closure link changes —
  // a symbol moving, appearing, or winning a name collision in a file the
  // page never imports — impossible to serve stale. The page's registry
  // contribution stays as-cached: re-registering after the loop would
  // flip last-writer-wins collision outcomes.
  for (const info of infos) {
    if (!info.fresh) continue;
    const recorded = prior!.entries[info.rel].linkTargets;
    const changed = Object.entries(recorded).some(
      ([name, target]) => (symbolRegistry[name] ?? null) !== target,
    );
    if (changed) {
      info.fresh = false;
      parseFor(info.filePath);
    }
  }

  // Pass 2 — render stale pages exactly as the uncached path does.
  const newEntries: Record<string, DocLedgerEntry> = {};
  for (const info of infos) {
    if (info.fresh) {
      newEntries[info.rel] = prior!.entries[info.rel];
      continue;
    }
    const resolved = resolveOwnedOutputPath(outDirReal, info.mdRelPath, {
      createParents: true,
    });
    if (resolved.leafIsSymlink) {
      throw new OwnedPathError(
        `refusing to write documentation through a symlink: ${info.mdRelPath}`,
      );
    }
    // Dependency snapshot BEFORE rendering: generateDocForFile's symbol
    // table is what consumes dependency semantics, so this is the last
    // instant the hashes are guaranteed to describe what rendering sees.
    const preRender = captureDepSnapshot(info.filePath, config, ctx.stdlibDir);
    const linkRecorder: Record<string, string | null> = {};
    const program = parsedPrograms.get(info.filePath)!;
    const written = generateDocForFile(
      info.filePath,
      resolved.abs,
      {
        baseUrl,
        sourceRelPath: info.rel,
        symbolRegistry,
        currentMdPath: info.mdRelPath,
        config,
        linkRecorder,
      },
      program,
    );
    if (isSafeSourceRel(info.rel)) {
      newEntries[info.rel] = buildDocLedgerEntry({
        sourceRel: info.rel,
        ctx,
        config,
        registrySymbols: extractRegistrySymbols(program),
        linkTargets: linkRecorder,
        writtenBytes: written,
        sourceHashAtParse: sourceHashAtParse.get(info.filePath),
        preRender,
      });
    }
  }

  // Reconciliation: prior-owned pages absent from the new desired set.
  // Deletion authority is the validated prior ledger; the path is always
  // recomputed from the key (never the stored outputPath field), and a
  // symlinked ancestor skips the delete entirely. A leaf symlink is
  // unlinked as a link, never followed.
  if (authority) {
    const desired = new Set(Object.keys(newEntries).map(outputPathFor));
    for (const rel of Object.keys(prior!.entries)) {
      const outRel = outputPathFor(rel);
      if (desired.has(outRel)) continue;
      let target;
      try {
        target = resolveOwnedOutputPath(outDirReal, outRel);
      } catch {
        continue;
      }
      // Delete only what a generated page can be — a regular file, or a
      // leaf symlink (removed as a link). Anything else (e.g. a directory
      // now occupying the path) is not ours; skip rather than crash.
      let leaf: fs.Stats;
      try {
        leaf = fs.lstatSync(target.abs);
      } catch {
        continue; // already gone
      }
      if (!leaf.isFile() && !leaf.isSymbolicLink()) {
        continue;
      }
      fs.rmSync(target.abs, { force: true });
    }
  }

  saveDocLedger(outDirReal, {
    version: 1,
    outputDir: outDirReal,
    identity: { inputDir: inputDirReal, ignoreDirs: sortedIgnore },
    renderKey,
    entries: newEntries,
  });
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A file's pass-1 registry contributions. NOT "exported symbols": all
 *  function definitions (non-exported and underscore-prefixed included),
 *  node names, global-scope type aliases, and exported constants — the
 *  set link targets resolve against. Cached per page as
 *  `registrySymbols`, so an unchanged file costs no parse.
 *
 *  `@hidden` declarations are left out. A hidden type alias is the case
 *  that matters: it renders no section, so a link to it from another page
 *  would point at an anchor that does not exist. */
export function extractRegistrySymbols(program: AgencyProgram): string[] {
  const info = buildCompilationUnit(program);
  const out: string[] = [];
  for (const [name, fn] of Object.entries(info.functionDefinitions)) {
    if (!isHidden(fn.tags)) out.push(name);
  }
  for (const node of info.graphNodes) {
    if (!isHidden(node.tags)) out.push(declaredName(node.nodeName));
  }
  for (const [name, alias] of Object.entries(info.typeAliases.get(GLOBAL_SCOPE_KEY) ?? {})) {
    if (!isHidden(alias.tags)) out.push(name);
  }
  for (const c of collectExportedConstants(program)) {
    if (!isHidden(c.tags)) out.push(c.variableName);
  }
  return out;
}

function preprocessProgram(program: AgencyProgram, config: AgencyConfig): AgencyProgram {
  const preprocessor = new TypescriptPreprocessor(program, config);
  preprocessor.attachDocComments();
  // Attach `@validate(...)` / `@jsonSchema(...)` / other tags onto their
  // target nodes (type aliases, functions, etc.) so the rendered code
  // block in the docs includes those annotations.
  preprocessor.attachTags();
  return program;
}

/**
 * One symbol table PER PAGE, rooted at that page's own file.
 *
 * The memo lives on the DocContext, and generateDoc constructs a fresh
 * context for every page — so despite the memo, no table is ever shared
 * across pages. (An older comment here claimed one table per run; the
 * code never did that.) This per-page behavior is the parity baseline the
 * incremental cache preserves: a page's Throws column is computed from a
 * crawl rooted at that page, and fresh pages build no table at all.
 */
function symbolTableFor(filePath: string, ctx: DocContext): SymbolTable {
  if (!ctx.symbolTable) {
    ctx.symbolTable = SymbolTable.build(filePath, ctx.config);
  }
  return ctx.symbolTable;
}

function generateDocForFile(
  filePath: string,
  outputPath: string,
  ctx: DocContext,
  program: AgencyProgram,
): string {
  // A symbol table is what makes an imported function's effects visible. The
  // Throws column understated everything reached through an import without it
  // — a guard block in another module never showed up (GitHub issue 680).
  // Building it can throw on an unresolvable import, and the doc command
  // should still produce output for a file it cannot fully resolve.
  let info: CompilationUnit;
  try {
    info = buildCompilationUnit(program, symbolTableFor(filePath, ctx), filePath);
  } catch (e) {
    console.error(`[doc] no symbol table for ${filePath}; Throws may be short:`, e);
    info = buildCompilationUnit(program);
  }

  // We intentionally ignore type errors here — the doc command should produce
  // output even for files that don't fully type-check.
  let interruptEffectsByFunction: Record<string, InterruptEffect[]> = {};
  try {
    const result = typeCheck(program, ctx.config, info);
    interruptEffectsByFunction = result.interruptEffectsByFunction;
  } catch {
    // Fall back to no interrupt info if the type checker crashes.
  }

  warnOnStrayHiddenTags(program, filePath);

  const typeAliases: TypeAlias[] = [];
  const effectDecls: EffectDeclaration[] = [];
  for (const node of program.nodes) {
    if (node.type === "typeAlias") {
      typeAliases.push(node);
    } else if (node.type === "effectDeclaration") {
      effectDecls.push(node);
    }
  }
  const constants = collectExportedConstants(program);

  const title = path.basename(filePath).replace(/\.agency$/, "");
  const safeName = title.replace(/["\\\n]/g, "");
  const fmLines = [`name: "${safeName}"`];
  const description = moduleDescription(program.docComment);
  if (description) {
    fmLines.push(`description: "${description}"`);
  }
  const frontmatter = `---\n${fmLines.join("\n")}\n---`;
  const sections: string[] = [frontmatter, heading(1, title)];

  // Page-level "View source" link
  if (ctx.baseUrl && ctx.sourceRelPath) {
    // sections.push(`[View source](${ctx.baseUrl}/${toPosixPath(ctx.sourceRelPath)})`);
  }

  if (program.docComment) {
    const { body } = extractSummaryOverride(program.docComment.content);
    sections.push(formatDocComment({ ...program.docComment, content: body }));
  }

  const typeSection = generateTypeSection(typeAliases, ctx);
  if (typeSection) sections.push(typeSection);

  const effectSection = generateEffectSection(effectDecls, ctx);
  if (effectSection) sections.push(effectSection);

  const constantSection = generateConstantSection(constants, ctx);
  if (constantSection) sections.push(constantSection);

  const functions = Object.values(info.functionDefinitions);
  const functionSection = generateFunctionSection(functions, ctx, interruptEffectsByFunction);
  if (functionSection) sections.push(functionSection);

  const nodeSection = generateNodeSection(info.graphNodes, ctx, interruptEffectsByFunction);
  if (nodeSection) sections.push(nodeSection);
  const generatedOutput = postprocessDoc(sections.join("\n\n") + "\n");
  fs.writeFileSync(outputPath, generatedOutput);
  return generatedOutput;
}

/** `attachTags` moves a tag onto the next declaration, but only for the
 *  kinds it knows: functions, nodes, type aliases, constants, and calls.
 *  A `@hidden` above anything else — an `effect` block, say — is left
 *  behind as a loose tag node and would otherwise do nothing at all,
 *  silently. Say so instead. */
function warnOnStrayHiddenTags(program: AgencyProgram, filePath: string): void {
  for (const node of program.nodes) {
    if (node.type !== "tag" || node.name !== HIDDEN_TAG) continue;
    const where = node.loc ? `:${node.loc.line + 1}` : "";
    console.error(
      `[doc] @${HIDDEN_TAG} at ${path.basename(filePath)}${where} is not attached to a declaration it can hide; ignoring.`,
    );
  }
}

function postprocessDoc(doc: string): string {
  return doc;
  // escape < and > for all xml
  // return doc.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function formatType(type: VariableType | undefined | null): string {
  if (!type) return "";
  return variableTypeToString(type, {})
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

export function formatTypeLinked(type: VariableType | undefined | null, ctx: DocContext): string {
  if (!type) return "";
  const plain = formatType(type);
  if (type.type !== "typeAliasVariable") return "`" + plain + "`";

  const name = type.aliasName;
  const targetMdPath = ctx.symbolRegistry[name];
  if (ctx.linkRecorder) {
    // Misses are recorded as null so a symbol APPEARING elsewhere later
    // also invalidates this page.
    ctx.linkRecorder[name] = targetMdPath ?? null;
  }
  if (!targetMdPath) return "`" + plain + "`";

  if (targetMdPath === ctx.currentMdPath) {
    return `[${name}](#${name.toLowerCase()})`;
  }

  const from = path.dirname(ctx.currentMdPath || "");
  const rel = path.relative(from, targetMdPath);
  return `[${name}](${toPosixPath(rel)}#${name.toLowerCase()})`;
}

function sourceLink(loc: { line: number } | undefined, ctx: DocContext): string {
  if (!ctx.baseUrl || !ctx.sourceRelPath || !loc) return "";
  return `([source](${ctx.baseUrl}/${toPosixPath(ctx.sourceRelPath)}#L${loc.line + 1}))`;
}

// Debug-independent on purpose: AGENCY_DEBUG makes the generator wrap
// rendered code in trace markers, which would both pollute doc pages and
// make cached output diverge from a cold run under a different
// environment (the render key deliberately excludes the environment).
const generator = new AgencyGenerator({ debug: false });

function formatDefaultValue(node: FunctionParameter["defaultValue"]): string {
  if (!node) return "";
  return generator.processNode(node).trim();
}

function generateParamTable(params: FunctionParameter[], ctx: DocContext): string | null {
  if (params.length === 0) return null;
  const rows = params.map((p) => [
    p.name,
    p.typeHint ? formatTypeLinked(p.typeHint, ctx) : "",
    formatDefaultValue(p.defaultValue),
  ]);
  return `${bold("Parameters:")}\n\n${markdownTable(["Name", "Type", "Default"], rows)}`;
}

function formatDocComment(comment: AgencyMultiLineComment): string {
  return comment.content.trim();
}

// Moved to lib/utils/moduleDoc.ts so std::agency's describe() shares the
// same "module summary" extraction; re-exported here for existing callers.
export {
  extractSummaryOverride,
  firstParagraph,
  firstSentence,
  sanitizeDescription,
  moduleDescription,
} from "../utils/moduleDoc.js";
import { extractSummaryOverride, moduleDescription } from "../utils/moduleDoc.js";

function formatTypeAlias(alias: TypeAlias, ctx: DocContext): string {
  const code = generateAgency(
    {
      type: "agencyProgram",
      nodes: [alias],
    },
    { debug: false },
  );
  return section(
    heading(3, alias.aliasName),
    alias.docComment ? formatDocComment(alias.docComment) : null,
    codeFence(code),
    formatValidatorsAndSchema(alias.tags),
    sourceLink(alias.loc, ctx),
  );
}

function generateTypeSection(aliases: TypeAlias[], ctx: DocContext): string | null {
  const visible = aliases.filter((a) => a.exported && !isHidden(a.tags));
  if (visible.length === 0) return null;
  return section(heading(2, "Types"), ...visible.map((a) => formatTypeAlias(a, ctx)));
}

function formatEffectDeclaration(decl: EffectDeclaration, ctx: DocContext): string {
  const code = generateAgency(
    {
      type: "agencyProgram",
      nodes: [decl],
    },
    { debug: false },
  );
  return section(
    heading(3, decl.effect),
    decl.docComment ? formatDocComment(decl.docComment) : null,
    codeFence(code),
    sourceLink(decl.loc, ctx),
  );
}

function generateEffectSection(decls: EffectDeclaration[], ctx: DocContext): string | null {
  if (decls.length === 0) return null;
  return section(heading(2, "Effects"), ...decls.map((d) => formatEffectDeclaration(d, ctx)));
}

/**
 * Format the runtime validators + JSON-schema annotations attached to a
 * type alias (or any other tagged target). Returns `null` if no
 * `@validate(...)` or `@jsonSchema(...)` tags are present so callers
 * can elide the section.
 */
function formatValidatorsAndSchema(tags: Tag[] | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  const parts: string[] = [];

  const validators: string[] = [];
  for (const t of tags) {
    if (t.name !== "validate") continue;
    for (const arg of t.arguments) {
      validators.push("`" + generator.processNode(arg).trim() + "`");
    }
  }
  if (validators.length > 0) {
    parts.push(`${bold("Validators:")} ${validators.join(", ")}`);
  }

  const jsonSchemaTag = tags.find((t) => t.name === "jsonSchema");
  if (jsonSchemaTag) {
    const arg = jsonSchemaTag.arguments[0];
    if (arg) {
      const rendered = generator.processNode(arg).trim();
      parts.push(`${bold("JSON Schema metadata:")}\n\n${codeFence(rendered, "agency")}`);
    }
  }

  return parts.length === 0 ? null : parts.join("\n\n");
}

function collectExportedConstants(program: AgencyProgram): Assignment[] {
  const out: Assignment[] = [];
  for (const node of program.nodes) {
    if (node.type === "assignment" && node.exported && node.declKind === "const") {
      out.push(node as Assignment);
    }
  }
  return out;
}

function formatConstant(c: Assignment, ctx: DocContext): string {
  // Render the declaration via the agency generator so it picks up any
  // attached `@validate(...)` / `@jsonSchema(...)` tags and the doc
  // comment.
  const code = generateAgency(
    {
      type: "agencyProgram",
      nodes: [c],
    },
    { debug: false },
  );
  return section(
    heading(3, c.variableName),
    codeFence(code),
    c.typeHint ? `${bold("Type:")} ${formatTypeLinked(c.typeHint, ctx)}` : null,
    formatValidatorsAndSchema(c.tags),
    sourceLink(c.loc, ctx),
  );
}

function generateConstantSection(constants: Assignment[], ctx: DocContext): string | null {
  const visible = constants.filter((c) => !isHidden(c.tags));
  if (visible.length === 0) return null;
  return section(heading(2, "Constants"), ...visible.map((c) => formatConstant(c, ctx)));
}

function formatThrows(kinds: InterruptEffect[] | undefined): string | null {
  if (!kinds || kinds.length === 0) return null;
  const formatted = kinds.map((k) => "`" + (k.effect || "unknown") + "`").join(", ");
  return `${bold("Throws:")} ${formatted}`;
}

function generateFunctionSection(
  fns: FunctionDefinition[],
  ctx: DocContext,
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
): string | null {
  const visible = fns.filter((fn) => {
    if (!fn.exported) return false;
    // Underscore-prefixed exports are internal plumbing (e.g. `_guard`,
    // the guard construct's lowering target) — exported for the
    // compiler's sake, not the user's. Their story belongs in docs/dev.
    if (declaredName(fn.functionName).startsWith("_")) return false;
    return !isHidden(fn.tags);
  });
  if (visible.length === 0) return null;
  const parts = visible.map((fn) => {
    const sig = generator.signatureOf(fn);
    return section(
      heading(3, declaredName(fn.functionName)),
      codeFence(sig),
      fn.docString ? docStringText(fn.docString) : null,
      fn.docComment ? formatDocComment(fn.docComment) : null,
      generateParamTable(fn.parameters, ctx),
      fn.returnType ? `${bold("Returns:")} ${formatTypeLinked(fn.returnType, ctx)}` : null,
      formatThrows(interruptEffectsByFunction[declaredName(fn.functionName)]),
      sourceLink(fn.loc, ctx),
    );
  });
  return section(heading(2, "Functions"), ...parts);
}

function generateNodeSection(
  nodes: GraphNodeDefinition[],
  ctx: DocContext,
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
): string | null {
  // A node that is not exported cannot be reached by anyone importing the
  // module, so it is not part of the module's surface — the same rule the
  // function, type, and constant sections have always applied.
  const visible = nodes.filter((node) => node.exported && !isHidden(node.tags));
  if (visible.length === 0) return null;
  const parts = visible.map((node) => {
    const sig = generator.signatureOf(node);
    return section(
      heading(3, declaredName(node.nodeName)),
      codeFence(sig),
      node.docString ? docStringText(node.docString) : null,
      node.docComment ? formatDocComment(node.docComment) : null,
      generateParamTable(node.parameters, ctx),
      node.returnType ? `${bold("Returns:")} ${formatTypeLinked(node.returnType, ctx)}` : null,
      formatThrows(interruptEffectsByFunction[declaredName(node.nodeName)]),
      sourceLink(node.loc, ctx),
    );
  });
  return section(heading(2, "Nodes"), ...parts);
}
