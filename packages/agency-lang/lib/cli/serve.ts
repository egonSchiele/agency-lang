import fs from "fs";
import path from "path";
import process from "process";
import { pathToFileURL } from "url";
import { compile, loadConfig } from "./commands.js";
import { SymbolTable } from "../symbolTable.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck, formatErrors } from "../typeChecker/index.js";
import { discoverExports } from "../serve/discovery.js";
import { createMcpHandler, startStdioServer } from "../serve/mcp/adapter.js";
import { startHttpServer } from "../serve/http/adapter.js";
import { createLogger } from "../logger.js";
import { VERSION } from "../version.js";
import type { ExportedItem } from "../serve/types.js";
import type { InterruptKind } from "../symbolTable.js";
import type { InterruptHandlers } from "../serve/mcp/interruptLoop.js";
import { PolicyStore } from "../serve/policyStore.js";
import * as esbuild from "esbuild";

type CompileResult = {
  outputPath: string;
  moduleId: string;
  exportedNodeNames: string[];
  interruptKindsByName: Record<string, InterruptKind[]>;
};

function compileForServe(file: string): CompileResult {
  const config = loadConfig();
  const absoluteFile = path.resolve(file);
  const symbolTable = SymbolTable.build(absoluteFile, config);

  const outputPath = compile(config, file, undefined, { symbolTable });
  if (!outputPath) {
    throw new Error(`Compilation failed for ${file}`);
  }

  const fileSymbols = symbolTable.getFile(absoluteFile);
  const exportedNodeNames = Object.values(fileSymbols ?? {})
    .filter((sym) => sym.kind === "node" && sym.exported)
    .map((sym) => sym.name);

  // Run type checker to get transitive interrupt kinds and report errors
  const source = fs.readFileSync(absoluteFile, "utf-8");
  const parseResult = parseAgency(source, config);
  const interruptKindsByName: Record<string, InterruptKind[]> = {};
  if (parseResult.success) {
    const info = buildCompilationUnit(parseResult.result, symbolTable, absoluteFile, source);
    const result = typeCheck(parseResult.result, config, info);
    const typeErrors = result.errors.filter((e) => e.severity !== "warning");
    const warnings = result.errors.filter((e) => e.severity === "warning");
    if (typeErrors.length > 0) {
      console.error(formatErrors(typeErrors));
    }
    if (warnings.length > 0) {
      console.error(formatErrors(warnings, "warning"));
    }
    Object.assign(interruptKindsByName, result.interruptKindsByFunction);
  }

  const moduleId = path.relative(process.cwd(), absoluteFile);
  return { outputPath, moduleId, exportedNodeNames, interruptKindsByName };
}

async function loadAndDiscover(
  compileResult: CompileResult,
): Promise<{ exports: ExportedItem[]; moduleExports: Record<string, unknown> }> {
  const moduleUrl = pathToFileURL(path.resolve(compileResult.outputPath)).href;
  const mod = await import(moduleUrl);
  const moduleExports = mod as Record<string, unknown>;

  const toolRegistry =
    (moduleExports.__toolRegistry as Record<string, any>) ?? {};

  const exports = discoverExports({
    toolRegistry,
    moduleExports,
    moduleId: compileResult.moduleId,
    exportedNodeNames: compileResult.exportedNodeNames,
    interruptKindsByName: compileResult.interruptKindsByName,
  });

  return { exports, moduleExports };
}

export async function serveMcp(
  file: string,
  options: { name?: string },
): Promise<void> {
  const compileResult = compileForServe(file);
  const { exports, moduleExports } = await loadAndDiscover(compileResult);

  const serverName = options.name ?? path.basename(file, ".agency");
  const policyStore = new PolicyStore(serverName);

  // The compiled module's hasInterrupts checks raw data, but respondToInterrupts
  // returns { data: ... }. We normalize here so the interrupt loop sees a
  // consistent shape.
  const rawHasInterrupts = moduleExports.hasInterrupts as (data: unknown) => boolean;
  const rawRespondToInterrupts = moduleExports.respondToInterrupts as (
    interrupts: unknown[],
    responses: unknown[],
  ) => Promise<{ data: unknown }>;

  const interruptHandlers: InterruptHandlers = {
    hasInterrupts: rawHasInterrupts,
    respondToInterrupts: async (interrupts, responses) => {
      const wrapped = await rawRespondToInterrupts(interrupts, responses);
      return wrapped.data;
    },
  };

  const handler = createMcpHandler({
    serverName,
    serverVersion: VERSION,
    exports,
    policyConfig: { policyStore, interruptHandlers },
  });

  startStdioServer(handler);
}

export async function serveHttp(
  file: string,
  options: { port?: string; apiKey?: string; standalone?: boolean },
): Promise<void> {
  const compileResult = compileForServe(file);

  if (options.standalone) {
    await generateStandalone(compileResult.outputPath, file);
    return;
  }

  const { exports, moduleExports } = await loadAndDiscover(compileResult);
  const port = parseInt(options.port ?? "3545", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  const logger = createLogger("info");

  startHttpServer({
    exports,
    port,
    apiKey: options.apiKey,
    logger,
    hasInterrupts: moduleExports.hasInterrupts as (data: unknown) => boolean,
    respondToInterrupts: moduleExports.respondToInterrupts as (
      interrupts: unknown[],
      responses: unknown[],
    ) => Promise<unknown>,
  });
}

async function generateStandalone(
  compiledPath: string,
  originalFile: string,
): Promise<void> {
  const outfile = path.basename(originalFile, ".agency") + ".server.js";

  await esbuild.build({
    entryPoints: [compiledPath],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    banner: {
      js: "// Generated by Agency — standalone HTTP server\n",
    },
  });

  console.log(`Standalone server written to ${outfile}`);
}
