import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { SymbolTable } from "./symbolTable.js";
import { parseAgencyFileCached } from "./parseCache.js";
import { callSummaries, propagateToFixpoint, summaryKey } from "./analysis/effects.js";
import { collectBodyFacts } from "./analysis/bodyFacts.js";
import { walkNodes } from "./utils/node.js";
import { getImportedNames } from "./types/importStatement.js";
import type { AgencyProgram } from "./types.js";
import { declaredName } from "./types/hole.js";

function agencyFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return agencyFilesUnder(full);
    }
    return entry.name.endsWith(".agency") ? [full] : [];
  });
}

/**
 * Functions that call a `stdlib-lib` helper and need nothing from the host,
 * with a sentence per group. A function on this list may carry no tag and
 * reach no tagged function. Everything else that reaches a helper must. An
 * entry is a function name, or `file: name` when two modules share a name
 * and only one of them needs nothing (`hline` in `std::ui/layout` returns
 * text; `hline` in `std::ui/cli` asks the terminal for its width).
 */
const TOUCHES_NOTHING: Record<string, string[]> = {
  "pure helpers over values, with no host at all": [
    "range",
    "keys",
    "values",
    "entries",
    "round",
    "join",
    "resolve",
    "basename",
    "dirname",
    "extname",
    "relative",
    "isAbsolute",
    "cosineSimilarity",
    "detectLanguage",
    "highlight",
    "patch",
    "parseArgs",
    "isEmail",
    "isUrl",
    "isUuid",
    "isInt",
    "isPositive",
    "isNegative",
    "min",
    "max",
    "minLength",
    "maxLength",
    "matches",
    "isJsonValue",
    "frontmatter",
    "walk",
    "renderForCli",
    "renderForHtml",
    "tag",
    "setTags",
    "getTags",
    "redact",
    "removeTag",
    "removeAllTags",
    "saveDraft",
    "callback",
    "withLock",
    "hostedSearchTools",
    "mostCommon",
    "bashParser",
    "s3PresignGet",
    "dateStrToEpochMs",
    "elapsedTime",
    "_pairsOf",
    "mapWithIndex",
    "mapValues",
    "mapEntries",
    "filterEntries",
    "everyEntry",
    "someEntry",
    "isJsonObject",
    "recordScopedRule",
    "askUserChoices",
    "docsToolFromEntries",
    "bundledDocsDir",
    "disableMemory",
  ],
  "a guard: its trip is raised on the TypeScript side and needs no host": ["_guard"],
  "agents and strategies that assemble a prompt and hand on the tools they are given": [
    "agencyExpertAgent",
    "agencyResearcherAgent",
    "codingAgent",
    "promptRewriter",
    "researcherAgent",
    "dataAgent",
    "expertAgent",
    "explorerAgent",
    "docsOnlyHandler",
    "oracleAgent",
    "reviewAgent",
    "typescriptReviewAgent",
    "verifierAgent",
    "writingReviewAgent",
    "writingRewriteAgent",
    "supervise",
    "sample",
    "consensus",
    "retry",
    "retryWithFeedback",
  ],
  "the clock and the system part, which every host has": [
    "now",
    "today",
    "tomorrow",
    "nextDayOfWeek",
    "atTime",
    "startOfDay",
    "endOfDay",
    "startOfWeek",
    "endOfWeek",
    "startOfMonth",
    "endOfMonth",
    "format",
    "formatDate",
    "parse",
    "formatDuration",
    "sleep",
    "args",
    "cwd",
    "setTitle",
    "applyAgentCwd",
    "exit",
  ],
  "run state and conversation threads, which live in memory": [
    "setLlmOptions",
    "setModel",
    "listHostedModels",
    "hostedModelInfo",
    "modelSupportsInput",
    "isMemoryActive",
    "setMemoryId",
    "getMemoryId",
    "systemMessage",
    "userMessage",
    "toolMessage",
    "assistantMessage",
    "image",
    "file",
    "audio",
    "endTurn",
    "handBack",
    "getCost",
    "threadIsNew",
    "ensureSystemMessage",
    "getTokens",
    "getModelCosts",
    "lastReply",
    "listThreads",
    "sessionThreadId",
    "currentThreadId",
    "getThread",
    "setAgentName",
    "evalValue",
    "evalOutput",
    "evalRecord",
    "evalValues",
    "evalOutputs",
    "finalEvalOutput",
    "withWritesPolicy",
    "builtinPolicy",
    "builtinPolicyNames",
    "checkPolicy",
    "validatePolicy",
    "alwaysScopeFor",
    "defaultScopedFields",
    "buildScopedMatch",
  ],
  "the compiler in process: parsing and printing Agency text": [
    "getImports",
    "getFunctions",
    "getGraphNodes",
    "describe",
    "parseAST",
    "holesOf",
    "fill",
    "combine",
    "toSource",
    "parseExpr",
    "parseStatements",
    "walkAST",
    "getNodesOfType",
    "filterImports",
  ],
  "model management that reads a catalog shipped with the package, or asks a running server": [
    "localModelsSupported",
    "resolveModelName",
    "localModelBackend",
    "mlxServedName",
    "registerLocalProvider",
    "isMcpAvailable",
    "mergeMcpServers",
  ],
  "terminal drawing that returns text and prints nothing": [
    "setSlashPalette",
    "clearHistory",
    "ui/layout.agency: hline",
    "text",
    "raw",
    "space",
    "vline",
    "row",
    "column",
    "box",
    "line",
    "list",
    "textInput",
    "barChart",
    "table",
  ],
};

const ALLOWED = Object.values(TOUCHES_NOTHING).flat();

function isAllowed(stdlib: string, file: string, name: string): boolean {
  return ALLOWED.includes(name) || ALLOWED.includes(`${path.relative(stdlib, file)}: ${name}`);
}

/** The local names a file imports from `agency-lang/stdlib-lib`. */
function helperNames(program: AgencyProgram): string[] {
  return program.nodes.flatMap((node) =>
    node.type === "importStatement" && node.modulePath.includes("stdlib-lib/")
      ? node.importedNames.flatMap(getImportedNames)
      : [],
  );
}

type Callable = { file: string; name: string; exported: boolean; callsHelper: boolean };

function callablesOf(file: string, program: AgencyProgram): Callable[] {
  const helpers = helperNames(program);
  const out: Callable[] = [];
  for (const { node } of walkNodes(program.nodes)) {
    if (node.type !== "function" && node.type !== "graphNode") {
      continue;
    }
    const name = declaredName(node.type === "function" ? node.functionName : node.nodeName);
    const callees = collectBodyFacts(node.body).callees;
    out.push({
      file,
      name,
      exported: !!node.exported,
      callsHelper: callees.some((callee) => helpers.includes(callee)),
    });
  }
  return out;
}

/**
 * Every exported stdlib function that can reach a `stdlib-lib` helper by
 * calling carries a tag, its own or one it inherits through a call, unless
 * it is on the list above. The compiler already decides who calls whom and
 * what each function needs (the `capabilities` view of the propagation
 * pass); this test reads those answers and adds one more fixpoint over the
 * same edges for "reaches a helper", so a tag the pass cannot see fails
 * here before it is a gap anywhere else.
 */
describe("stdlib capability tags", () => {
  it("every exported function that reaches a host helper carries a tag or is listed", () => {
    const stdlib = path.join(process.cwd(), "stdlib");
    const files = agencyFilesUnder(stdlib);
    const table = SymbolTable.build(files, {});
    const programs: Record<string, AgencyProgram> = Object.create(null);
    for (const file of files) {
      const parsed = parseAgencyFileCached(file);
      if (!parsed.success) {
        throw new Error(`failed to parse ${file}`);
      }
      programs[file] = parsed.result;
    }
    const callables = files.flatMap((file) => callablesOf(file, programs[file]));
    const summaries = callSummaries(table, programs);
    const reach: Record<string, { effects: string[]; calleeKeys: string[] }> = Object.create(null);
    for (const callable of callables) {
      const key = summaryKey(callable);
      reach[key] = {
        effects: callable.callsHelper ? ["helper"] : [],
        calleeKeys: summaries[key]?.calleeKeys ?? [],
      };
    }
    propagateToFixpoint(reach);

    const untagged: string[] = [];
    for (const callable of callables) {
      if (!callable.exported || isAllowed(stdlib, callable.file, callable.name)) {
        continue;
      }
      if (reach[summaryKey(callable)].effects.length === 0) {
        continue;
      }
      const sym = table.getFile(callable.file)?.[callable.name];
      const needs =
        sym && (sym.kind === "function" || sym.kind === "node") ? (sym.capabilities ?? []) : [];
      if (needs.length === 0) {
        untagged.push(`${path.relative(stdlib, callable.file)}: ${callable.name}`);
      }
    }
    expect(untagged).toEqual([]);
  });

  it("lists no function that is tagged or reaches a tagged one", () => {
    // The allow list is for functions that need nothing. A name on it that
    // also carries a tag is a contradiction someone should resolve.
    const stdlib = path.join(process.cwd(), "stdlib");
    const files = agencyFilesUnder(stdlib);
    const table = SymbolTable.build(files, {});
    const contradictions: string[] = [];
    for (const file of files) {
      for (const [name, sym] of Object.entries(table.getFile(file) ?? {})) {
        if (sym.kind !== "function" && sym.kind !== "node") {
          continue;
        }
        if (isAllowed(stdlib, file, name) && (sym.capabilities ?? []).length > 0) {
          contradictions.push(`${path.relative(stdlib, file)}: ${name}`);
        }
      }
    }
    expect(contradictions).toEqual([]);
  });
});
