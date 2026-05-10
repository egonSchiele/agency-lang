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
  getStdlibDir,
} from "../importPaths.js";
import renderEvaluate from "@/templates/cli/evaluate.js";
import renderJudgeEvaluate from "@/templates/cli/judgeEvaluate.js";
import { compile } from "./commands.js";
import { RunStrategy } from "../importStrategy.js";
import { AgencyConfig } from "@/config.js";
import { parseAgency } from "@/parser.js";
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
  let nodeName: string = "";
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
};

export async function executeNodeAsync({
  config,
  agencyFile,
  nodeName,
  hasArgs,
  argsString,
  interruptHandlers,
  timeoutMs,
  signal,
}: ExecuteNodeArgs): Promise<{ data: any; stdout: string; stderr: string }> {
  let evaluateFile = "";
  let resultsFile = "";
  try {
    const distDir = config.distDir;
    let compiledPath: string;

    if (distDir) {
      compiledPath = resolveCompiledFile(distDir, agencyFile);
    } else {
      compiledPath = compile(config, agencyFile, undefined, {
        importStrategy: new RunStrategy(),
      })!;
    }

    const baseName = agencyFile.replace(".agency", "");
    evaluateFile = `${baseName}.evaluate.js`;
    resultsFile = `${baseName}.evaluate.json`;
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
    // SIGKILL (not SIGTERM) for timeout: these can be spinning subprocesses
    // (`while(true)`) where SIGTERM might be ignored. SIGKILL is uncatchable.
    const { stdout, stderr } = await execFileAsync("node", [evaluateFile], {
      maxBuffer: 10 * 1024 * 1024,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    const results = readFileSync(resultsFile, "utf-8");
    return { data: JSON.parse(results).data, stdout, stderr };
  } finally {
    safeUnlink(evaluateFile);
    safeUnlink(resultsFile);
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

/** Maps Agency primitive type names to their TypeScript equivalents. */
const TS_PRIMITIVE_ALIASES: Record<string, string> = {
  regex: "RegExp",
};

/**
 * Format a VariableType for display.
 *
 * Pass `primitiveAliases` (e.g. for codegen) to substitute Agency-only
 * primitive names with target-language equivalents. Default omits the map
 * so diagnostics, LSP hover, and CLI prompts show source-level keywords.
 */
export function formatTypeHint(
  vt: VariableType,
  primitiveAliases?: Record<string, string>,
): string {
  const recurse = (v: VariableType) => formatTypeHint(v, primitiveAliases);
  switch (vt.type) {
    case "primitiveType":
      return primitiveAliases?.[vt.value] ?? vt.value;
    case "arrayType":
      return `${recurse(vt.elementType)}[]`;
    case "stringLiteralType":
      return `"${vt.value}"`;
    case "numberLiteralType":
      return vt.value;
    case "booleanLiteralType":
      return vt.value;
    case "unionType":
      return vt.types.map(recurse).join(" | ");
    case "objectType":
      return `{ ${vt.properties.map((p) => `${p.key}: ${recurse(p.value)}`).join(", ")} }`;
    case "typeAliasVariable":
      return vt.aliasName;
    case "blockType": {
      const params = vt.params.map((p) => recurse(p.typeAnnotation)).join(", ");
      return `(${params}) => ${recurse(vt.returnType)}`;
    }
    case "resultType": {
      const s = recurse(vt.successType);
      const f = recurse(vt.failureType);
      if (s === "any" && f === "any") return "Result";
      return `Result<${s}, ${f}>`;
    }
    case "functionRefType": {
      const params = vt.params
        .map((p) => `${p.name}${p.typeHint ? `: ${recurse(p.typeHint)}` : ""}`)
        .join(", ");
      const ret = vt.returnType ? `: ${recurse(vt.returnType)}` : "";
      return `function ${vt.name}(${params})${ret}`;
    }
    default:
      throw new Error(`Unknown variable type: ${(vt as any).type}`);
  }
}

/** Convenience wrapper for codegen contexts. */
export function formatTypeHintTs(vt: VariableType): string {
  return formatTypeHint(vt, TS_PRIMITIVE_ALIASES);
}

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
  const judgeAgencyFile = path.resolve(currentDir, "../agents/judge.agency");

  // Compile judge to its default location (next to judge.agency).
  // Don't use a custom output path because compile() caches by source file
  // and would skip writing a second output for a different test.
  compile({}, judgeAgencyFile);
  const judgeCompiledFile = judgeAgencyFile.replace(".agency", ".js");

  const judgeEvaluateFile = `${agencyFileBaseName}.judge_evaluate.js`;
  const judgeResultsFile = `${agencyFileBaseName}.judge_evaluate.json`;
  const judgeEvaluateDir = path.dirname(path.resolve(judgeEvaluateFile));
  const judgeRelativePath = path
    .relative(judgeEvaluateDir, judgeCompiledFile)
    .split(path.sep)
    .join("/");
  const judgeScript = renderJudgeEvaluate({
    judgeFilename: judgeRelativePath,
    actualOutput: JSON.stringify(actualOutput),
    expectedOutput: JSON.stringify(expectedOutput),
    judgePrompt: JSON.stringify(judgePrompt),
    hasInterruptHandlers: !!interruptHandlers,
    interruptHandlersJSON: interruptHandlers
      ? JSON.stringify(interruptHandlers)
      : undefined,
    resultsFilename: judgeResultsFile,
  });

  fs.writeFileSync(judgeEvaluateFile, judgeScript);
  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      [judgeEvaluateFile],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const results = readFileSync(judgeResultsFile, "utf-8");
    const parsed = JSON.parse(results).data;
    return { score: parsed.score, reasoning: parsed.reasoning, stdout, stderr };
  } finally {
    try {
      fs.unlinkSync(judgeEvaluateFile);
    } catch {}
    try {
      fs.unlinkSync(judgeResultsFile);
    } catch {}
  }
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
  const isStdlibIndex = filename === path.join(getStdlibDir(), "index.agency");
  const parsed = parseAgency(contents, { verbose: false }, !isStdlibIndex);
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
