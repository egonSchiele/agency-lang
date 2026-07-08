import prompts from "prompts";

const onCancel = () => {
  process.exit(0);
};
import fs, { readFileSync } from "fs";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

export const execFileAsync = promisify(execFile);
import {
  AgencyProgram,
  GraphNodeDefinition,
  ImportStatement,
  VariableType,
} from "@/types.js";
import {
  isAgencyImport,
  resolveAgencyImportPath,
  isNonTemplatedStdlib,
} from "../importPaths.js";
import renderEvaluate from "@/templates/cli/evaluate.js";
import renderJudgeEvaluate from "@/templates/cli/judgeEvaluate.js";
import { compile } from "./commands.js";
import { RunStrategy } from "../importStrategy.js";
import { AgencyConfig } from "@/config.js";
import { parseAgency } from "@/parser.js";
import type { LLMMock, ScopedLLMMocks } from "../runtime/deterministicClient.js";
import type { FetchMock } from "../runtime/fetchMock.js";
import { writeFetchMocksTempFile } from "./fetchMockResolve.js";
export function parseTarget(target: string): {
  filename: string;
  nodeName: string;
} {
  const colonIndex = target.lastIndexOf(":");
  if (colonIndex === -1) {
    return { filename: target, nodeName: "" };
  }
  const filename = target.slice(0, colonIndex);
  const nodeName = target.slice(colonIndex + 1);
  return { filename, nodeName };
}

export async function promptForTarget(): Promise<{
  filename: string;
  nodeName: string;
}> {
  let filename: string = "";
  const nodeName: string = "";
  // Find all .agency files in the current directory
  const agencyFiles = fs
    .readdirSync(process.cwd())
    .filter((file) => file.endsWith(".agency"))
    .map((file) => ({
      title: file,
      value: file,
    }));

  const choices = [
    { title: "📝 Enter custom filename...", value: "__custom__" },
    ...agencyFiles,
  ];

  const response = await prompts(
    {
      type: "select",
      name: "filename",
      message: "Select an Agency file to read:",
      choices: choices,
    },
    { onCancel },
  );

  filename = response.filename;

  // If user chose custom option, prompt for filename
  if (filename === "__custom__") {
    const customResponse = await prompts(
      {
        type: "text",
        name: "filename",
        message: "Enter the filename to read:",
      },
      { onCancel },
    );
    filename = customResponse.filename;
  }

  return { filename, nodeName };
}

export async function pickANode(nodes: GraphNodeDefinition[]): Promise<string> {
  if (nodes.length === 0) {
    console.log("No nodes found in the file.");
    process.exit(0);
  }
  if (nodes.length === 1) {
    return nodes[0].nodeName;
  }
  const response = await prompts(
    {
      type: "select",
      name: "node",
      message: "Pick a node:",
      choices: nodes.map((node) => ({
        title: node.nodeName,
        value: node.nodeName,
      })),
    },
    { onCancel },
  );
  return response.node;
}

export async function promptForArgs(
  selectedNode: GraphNodeDefinition,
): Promise<{
  hasArgs: boolean;
  argsString: string;
}> {
  let hasArgs = false;
  let argsString = "";

  if (selectedNode.parameters.length > 0) {
    const paramNames = selectedNode.parameters.map((p) => p.name).join(", ");
    const confirmArgs = await prompts(
      {
        type: "confirm",
        name: "provideArgs",
        message: `This node has parameters (${paramNames}). Provide arguments?`,
        initial: true,
      },
      { onCancel },
    );

    if (confirmArgs.provideArgs) {
      const argValues: string[] = [];
      for (const param of selectedNode.parameters) {
        const typeLabel = param.typeHint
          ? ` (${formatTypeHint(param.typeHint)})`
          : "";
        const argResponse = await prompts(
          {
            type: "text",
            name: "value",
            message: `Value for ${param.name}${typeLabel}:`,
          },
          { onCancel },
        );
        argValues.push(serializeArgValue(argResponse.value));
      }
      argsString = argValues.join(", ");
      hasArgs = true;
    }
  }

  return { hasArgs, argsString };
}

export type InterruptHandler = {
  action: "approve" | "reject" | "modify" | "resolve";
  modifiedArgs?: Record<string, any>;
  resolvedValue?: any;
  expectedMessage?: string;
};

/**
 * Resolve the compiled .js file for an .agency file from a distDir.
 * Throws if the compiled file doesn't exist.
 */
export function resolveCompiledFile(
  distDir: string,
  agencyFile: string,
): string {
  const basename = path.basename(agencyFile, ".agency") + ".js";
  const compiledPath = path.resolve(distDir, basename);
  if (!fs.existsSync(compiledPath)) {
    throw new Error(
      `Compiled file not found: ${compiledPath}\n` +
        `Make sure you have compiled your Agency files and that distDir is correct.`,
    );
  }
  return compiledPath;
}

type ExecuteNodeArgs = {
  config: AgencyConfig;
  agencyFile: string;
  nodeName: string;
  hasArgs: boolean;
  argsString: string;
  interruptHandlers?: InterruptHandler[];
  // Per-call timeout (ms). When exceeded, execFile sends `killSignal` to
  // the child (we use SIGKILL — these are spinning subprocesses we want
  // dead, not given a chance to handle SIGTERM).
  timeoutMs?: number;
  // Suite-wide AbortSignal. When aborted (suite ceiling hit, or SIGINT
  // from user), the in-flight child is killed via execFile's signal
  // handling. Used by the test runner; safe to omit elsewhere.
  signal?: AbortSignal;
  // Optional ordered list of LLM mocks for the deterministic LLM client.
  // Passed to the subprocess as a JSON string in AGENCY_LLM_MOCKS env var
  // when AGENCY_USE_TEST_LLM_PROVIDER is set OR when useTestLLMProvider
  // is true. The compiled module's imports template auto-activates
  // DeterministicClient when this env var is present.
  llmMocks?: LLMMock[] | ScopedLLMMocks;
  // Force the deterministic LLM provider for this run even when the
  // suite-level AGENCY_USE_TEST_LLM_PROVIDER env var is unset. Use for
  // tests whose assertions depend on the deterministic client's fixed
  // per-call cost / token output. Setting this is equivalent to running
  // with AGENCY_USE_TEST_LLM_PROVIDER=1 for the spawned subprocess only.
  useTestLLMProvider?: boolean;
  // Extra command-line arguments forwarded to the spawned subprocess.
  // These land in `process.argv.slice(2)` of the running agent —
  // primarily for testing std::args and other argv-reading code.
  argv?: string[];
  // Optional writable directory for transient evaluate/result files. Useful
  // for bundled agents that may live in a read-only package install.
  scratchDir?: string;
  // Optional stdout/stderr buffer limit for callers that expose resource
  // controls. Defaults to the historical executeNodeAsync limit.
  maxBufferBytes?: number;
  // Suppress compile progress lines. Internal agent invocations (judge,
  // mutator) set this so their ephemeral compiles don't clutter user logs.
  quietCompile?: boolean;
  // Reuse a precompiled `.js` sibling when present instead of recompiling.
  // See RunAgencyNodeArgs.preferCompiled.
  preferCompiled?: boolean;
  // Fetch mocks for the deterministic fetch shim, already returnFile-inlined by
  // the caller (lib/cli/fetchMockResolve.ts). When defined (even as an empty
  // array — "no fetch may be made") the shim is installed via a temp file whose
  // path is passed in AGENCY_FETCH_MOCKS_FILE, independent of the LLM
  // deterministic flag. `undefined` means "no fetchMocks declared" — no shim.
  fetchMocks?: FetchMock[];
  // Test-harness only: honor `import test { … }` when compiling the agent.
  // Set solely by the test runner (lib/cli/test.ts); every other caller
  // omits it, so it defaults to deny.
  allowTestImports?: boolean;
};

export type RunAgencyNodeArgs = {
  config: AgencyConfig;
  agencyFile: string;
  nodeName: string;
  hasArgs: boolean;
  argsString: string;
  interruptHandlers?: InterruptHandler[];
  timeoutMs?: number;
  signal?: AbortSignal;
  argv?: string[];
  scratchDir?: string;
  maxBufferBytes?: number;
  quietCompile?: boolean;
  /** Extra env merged over process.env for the spawned subprocess. */
  env?: Record<string, string>;
  /**
   * Reuse a precompiled `.js` sitting next to the `.agency` source instead of
   * recompiling, when one exists. Bundled agents (judges, proposers) ship such
   * a sibling in `dist`, so repeated invocations (e.g. per optimize iteration)
   * skip the redundant compile. No-op when running from uncompiled source.
   */
  preferCompiled?: boolean;
  /** Test-harness only: honor `import test { … }` when compiling. Inert on
   *  the distDir/preferCompiled branches (nothing is compiled there). */
  allowTestImports?: boolean;
};

/**
 * General-purpose runner: compile/resolve the agent, render the evaluate
 * script, spawn `node`, and parse the results. No test-LLM coupling — callers
 * pass any extra `env` (e.g. the deterministic-LLM mocks computed by
 * `executeNodeAsync`).
 */
export async function runAgencyNode({
  config,
  agencyFile,
  nodeName,
  hasArgs,
  argsString,
  interruptHandlers,
  timeoutMs,
  signal,
  argv,
  scratchDir,
  maxBufferBytes,
  quietCompile,
  env,
  preferCompiled,
  allowTestImports,
}: RunAgencyNodeArgs): Promise<{ data: any; stdout: string; stderr: string }> {
  let evaluateFile = "";
  let resultsFile = "";
  try {
    const distDir = config.distDir;
    const siblingJs = agencyFile.replace(/\.agency$/, ".js");
    let compiledPath: string;

    if (distDir) {
      compiledPath = resolveCompiledFile(distDir, agencyFile);
    } else if (preferCompiled && agencyFile.endsWith(".agency") && fs.existsSync(siblingJs)) {
      // A precompiled sibling exists (bundled agents in dist) — reuse it
      // instead of recompiling the same unchanging source every call.
      compiledPath = siblingJs;
    } else {
      compiledPath = compile(config, agencyFile, undefined, {
        importStrategy: new RunStrategy(),
        quiet: quietCompile,
        allowTestImports,
      })!;
    }

    const baseName = agencyFile.replace(".agency", "");
    const evaluateBase = scratchDir
      ? path.join(scratchDir, path.basename(baseName))
      : baseName;
    evaluateFile = `${evaluateBase}.evaluate.js`;
    resultsFile = `${evaluateBase}.evaluate.json`;
    // The template imports via "./${filename}", so compute a relative path
    // from the evaluate script's directory to the compiled module.
    const evaluateDir = fs.realpathSync(path.dirname(evaluateFile));
    const compiledRealPath = fs.realpathSync(compiledPath);
    let importSpecifier = path
      .relative(evaluateDir, compiledRealPath)
      .replace(/\\/g, "/");
    if (!importSpecifier.startsWith(".")) {
      importSpecifier = `./${importSpecifier}`;
    }
    const evaluateScript = renderEvaluate({
      filename: importSpecifier,
      nodeName,
      hasArgs,
      args: argsString,
      hasInterruptHandlers: !!interruptHandlers,
      interruptHandlersJSON: interruptHandlers
        ? JSON.stringify(interruptHandlers)
        : undefined,
      resultsFilename: resultsFile,
    });
    fs.writeFileSync(evaluateFile, evaluateScript);
    // SIGKILL (not SIGTERM) for both the `timeout` AND `signal` paths:
    // these can be spinning subprocesses (`while(true)`) where SIGTERM
    // might be ignored. SIGKILL is uncatchable. Setting `killSignal`
    // covers both the per-call `timeout` option and the AbortSignal
    // (suite-ceiling/SIGINT) path, which otherwise default to SIGTERM.
    const wantsKill = timeoutMs !== undefined || signal !== undefined;
    // Forward `argv` so the spawned subprocess sees them as
    // `process.argv.slice(2)`. Used by std::args smoke tests and any
    // other code that reads command-line flags.
    const nodeArgs = argv !== undefined ? [evaluateFile, ...argv] : [evaluateFile];
    const { stdout, stderr } = await execFileAsync("node", nodeArgs, {
      maxBuffer: maxBufferBytes ?? 10 * 1024 * 1024,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(wantsKill ? { killSignal: "SIGKILL" as const } : {}),
      env: { ...process.env, ...(env ?? {}) },
    });
    const results = readFileSync(resultsFile, "utf-8");
    return { data: JSON.parse(results).data, stdout, stderr };
  } finally {
    safeUnlink(evaluateFile);
    safeUnlink(resultsFile);
  }
}

/**
 * Test/eval wrapper over {@link runAgencyNode}: activates the deterministic LLM
 * client by setting AGENCY_LLM_MOCKS whenever the suite-wide
 * AGENCY_USE_TEST_LLM_PROVIDER env var is set OR the per-call
 * `useTestLLMProvider` flag is true, then delegates. Existing callers keep
 * their behavior. Setting the env var to "[]" when no mocks are provided still
 * activates the deterministic client so any llm() call fails cleanly instead of
 * falling through to the real OpenAI client.
 */
export async function executeNodeAsync({
  llmMocks,
  useTestLLMProvider,
  fetchMocks,
  ...rest
}: ExecuteNodeArgs): Promise<{ data: any; stdout: string; stderr: string }> {
  const useDeterministic =
    !!process.env.AGENCY_USE_TEST_LLM_PROVIDER || !!useTestLLMProvider;
  const env: Record<string, string> = useDeterministic
    ? { AGENCY_LLM_MOCKS: JSON.stringify(llmMocks ?? []) }
    : {};

  // Activate the fetch shim whenever fetchMocks is *defined* — an empty array
  // means "this test may make no fetch calls" and must still install the shim
  // (so any fetch throws), matching the llmMocks precedent. `undefined` means
  // no fetchMocks were declared, so the shim stays off.
  let fetchMocksCleanup: (() => void) | undefined;
  if (fetchMocks) {
    const { file, cleanup } = writeFetchMocksTempFile(fetchMocks);
    env.AGENCY_FETCH_MOCKS_FILE = file;
    fetchMocksCleanup = cleanup;
  }

  try {
    return await runAgencyNode({ ...rest, env });
  } finally {
    fetchMocksCleanup?.();
  }
}

export function safeUnlink(filePath: string) {
  try {
    if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isDirectory()) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(`Warning: Failed to delete file ${filePath}:`, err);
  }
}

export function executeNode(args: ExecuteNodeArgs): {
  data: any;
  [key: string]: any;
} {
  const distDir = args.config.distDir;
  let compiledPath: string;

  if (distDir) {
    compiledPath = resolveCompiledFile(distDir, args.agencyFile);
  } else {
    compiledPath = compile(args.config, args.agencyFile, undefined, {
      importStrategy: new RunStrategy(),
      allowTestImports: args.allowTestImports,
    })!;
  }

  const evaluateFile = "__evaluate.js";
  // The template imports via "./${filename}", so compute a relative path
  // from the evaluate script's directory to the compiled module.
  let importSpecifier = path
    .relative(path.dirname(evaluateFile), compiledPath)
    .replace(/\\/g, "/");
  if (!importSpecifier.startsWith(".")) {
    importSpecifier = `./${importSpecifier}`;
  }
  const evaluateScript = renderEvaluate({
    filename: importSpecifier,
    nodeName: args.nodeName,
    hasArgs: args.hasArgs,
    args: args.argsString,
    hasInterruptHandlers: !!args.interruptHandlers,
    interruptHandlersJSON: args.interruptHandlers
      ? JSON.stringify(args.interruptHandlers)
      : undefined,
    resultsFilename: "__evaluate.json",
  });
  fs.writeFileSync(evaluateFile, evaluateScript);
  execFileSync("node", [evaluateFile], { stdio: "inherit" });
  const results = readFileSync("__evaluate.json", "utf-8");
  return JSON.parse(results);
}

// Re-exported for backward compatibility. The implementation lives in
// lib/utils/formatType.ts to avoid pulling in `prompts` (and its CJS
// readline dependency) when only the typechecker/LSP/codegen need it.
export {
  formatTypeHint,
  formatTypeHintTs,
  TS_PRIMITIVE_ALIASES,
} from "../utils/formatType.js";
import { formatTypeHint } from "../utils/formatType.js";

function serializeArgValue(value: string): string {
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return value;
  if (value === "true" || value === "false") return value;
  return JSON.stringify(value);
}

type ExecuteJudgeArgs = {
  actualOutput: string;
  expectedOutput: string;
  judgePrompt: string;
  interruptHandlers?: InterruptHandler[];
};

type RunAgencyJudgeArgs<TemplateData> = {
  judgeAgencyFile: string;
  renderRunner: (
    data: TemplateData & { judgeFilename: string; resultsFilename: string },
  ) => string;
  templateData: TemplateData;
  agencyFileBaseName: string;
};

async function runAgencyJudge<TemplateData, RawResult>({
  judgeAgencyFile,
  renderRunner,
  templateData,
  agencyFileBaseName,
}: RunAgencyJudgeArgs<TemplateData>): Promise<{
  raw: RawResult;
  stdout: string;
  stderr: string;
}> {
  compile({}, judgeAgencyFile);
  const judgeCompiledFile = judgeAgencyFile.replace(".agency", ".js");
  const judgeEvaluateFile = `${agencyFileBaseName}.judge_evaluate.js`;
  const judgeResultsFile = `${agencyFileBaseName}.judge_evaluate.json`;
  const judgeEvaluateDir = path.dirname(path.resolve(judgeEvaluateFile));
  const judgeRelativePath = path
    .relative(judgeEvaluateDir, judgeCompiledFile)
    .split(path.sep)
    .join("/");
  const judgeScript = renderRunner({
    ...templateData,
    judgeFilename: judgeRelativePath,
    resultsFilename: judgeResultsFile,
  });

  fs.writeFileSync(judgeEvaluateFile, judgeScript);
  try {
    const { stdout, stderr } = await execFileAsync("node", [judgeEvaluateFile], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const results = readFileSync(judgeResultsFile, "utf-8");
    return { raw: JSON.parse(results).data, stdout, stderr };
  } finally {
    safeUnlink(judgeEvaluateFile);
    safeUnlink(judgeResultsFile);
  }
}

export async function executeJudgeAsync(
  agencyFileBaseName: string,
  {
    actualOutput,
    expectedOutput,
    judgePrompt,
    interruptHandlers,
  }: ExecuteJudgeArgs,
): Promise<{
  score: number;
  reasoning: string;
  stdout: string;
  stderr: string;
}> {
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const judgeAgencyFile = path.resolve(currentDir, "../agents/eval/judge.agency");
  const { raw, stdout, stderr } = await runAgencyJudge<
    {
      actualOutput: string;
      expectedOutput: string;
      judgePrompt: string;
      hasInterruptHandlers: boolean;
      interruptHandlersJSON?: string;
    },
    { score: number; reasoning: string }
  >({
    judgeAgencyFile,
    renderRunner: renderJudgeEvaluate,
    templateData: {
      actualOutput: JSON.stringify(actualOutput),
      expectedOutput: JSON.stringify(expectedOutput),
      judgePrompt: JSON.stringify(judgePrompt),
      hasInterruptHandlers: !!interruptHandlers,
      interruptHandlersJSON: interruptHandlers
        ? JSON.stringify(interruptHandlers)
        : undefined,
    },
    agencyFileBaseName,
  });
  return { score: raw.score, reasoning: raw.reasoning, stdout, stderr };
}

export function* findRecursively(
  dirName: string,
  ext: string = ".agency",
  searched: string[] = [],
  ignoreDirs: string[] = [],
): Generator<{ path: string }> {
  searched.push(path.resolve(dirName));
  // Find all .agency files in the directory
  const files = fs.readdirSync(dirName);
  const filesToProcess = files.filter((file) => {
    if (file.startsWith(".")) return false;
    if (ignoreDirs.includes(file)) return false;
    return (
      file.endsWith(ext) ||
      fs.statSync(path.join(dirName, file)).isDirectory()
    );
  });

  for (const file of filesToProcess) {
    const fullPath = path.join(dirName, file);
    if (fs.lstatSync(fullPath).isSymbolicLink()) {
      continue;
    }
    if (fs.statSync(fullPath).isDirectory()) {
      if (!searched.includes(path.resolve(fullPath))) {
        yield* findRecursively(fullPath, ext, searched, ignoreDirs);
      }
    } else {
      yield { path: fullPath };
    }
  }
}

export function getImportsRecursively(
  filename: string,
  visited = new Set<string>(),
): string[] {
  if (visited.has(filename)) {
    return [];
  }
  visited.add(filename);
  const contents = fs.readFileSync(filename, "utf-8");
  const parsed = parseAgency(
    contents,
    { verbose: false },
    !isNonTemplatedStdlib(filename),
  );
  if (!parsed.success) {
    console.error(`Error parsing ${filename}:`, parsed);
    return [];
  }
  const program = parsed.result;
  const imports = getImports(program);
  for (const imp of imports) {
    const importedFile = resolveAgencyImportPath(imp, filename);
    if (fs.existsSync(importedFile)) {
      imports.push(...getImportsRecursively(importedFile, visited));
    } else {
      console.warn(`Warning: Imported file ${importedFile} not found.`);
    }
  }
  return imports;
}

export function getImports(program: AgencyProgram): string[] {
  const toolAndNodeImports = program.nodes
    .filter((node) => node.type === "importNodeStatement")
    .map((node) => node.agencyFile.trim());
  // this makes compile() try to parse non-agency files
  const importStatements = program.nodes
    .filter(
      (node) =>
        node.type === "importStatement" && isAgencyImport(node.modulePath),
    )
    .map((node) => (node as ImportStatement).modulePath.trim());

  return [...toolAndNodeImports, ...importStatements];
}

// Returns EVERY import in the program, regardless of whether it points to
// agency code (`.agency` / `std::` / `pkg::`) or a raw npm/Node module
// (e.g. `fs`, `child_process`). Use this when you need to inspect or
// validate the full import surface — `getImports` filters out non-agency
// imports, which is the wrong behavior for restriction checks.
export type AnyImport = { path: string; kind: "module" | "node" };
export function getAllImports(program: AgencyProgram): AnyImport[] {
  return program.nodes.flatMap((node): AnyImport[] => {
    if (node.type === "importStatement") {
      return [{ path: node.modulePath.trim(), kind: "module" }];
    }
    if (node.type === "importNodeStatement") {
      return [{ path: node.agencyFile.trim(), kind: "node" }];
    }
    return [];
  });
}
