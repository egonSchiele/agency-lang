import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath, pathToFileURL } from "url";
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
import renderStandaloneHttp from "../templates/cli/standaloneHttp.js";
import renderStandaloneMcp from "../templates/cli/standaloneMcp.js";

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
  options: { name?: string; standalone?: boolean },
): Promise<void> {
  const compileResult = compileForServe(file);

  const serverName = options.name ?? path.basename(file, ".agency");

  if (options.standalone) {
    await generateStandalone("mcp", compileResult, file, { serverName });
    return;
  }

  const { exports, moduleExports } = await loadAndDiscover(compileResult);
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
  options: {
    port?: string;
    host?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    standalone?: boolean;
  },
): Promise<void> {
  const compileResult = compileForServe(file);

  const port = parseInt(options.port ?? "3545", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  if (options.apiKey !== undefined && options.apiKeyEnv !== undefined) {
    throw new Error("--api-key and --api-key-env are mutually exclusive.");
  }

  if (options.standalone) {
    if (options.apiKey !== undefined) {
      throw new Error(
        "--api-key cannot be used with --standalone. The standalone bundle reads the key from an environment variable at runtime; use --api-key-env <name> to choose which one (default: API_KEY).",
      );
    }
    await generateStandalone("http", compileResult, file, {
      port,
      host: options.host ?? "127.0.0.1",
      apiKeyEnv: options.apiKeyEnv ?? "API_KEY",
    });
    return;
  }

  // Non-standalone: --api-key-env reads the key from the named env var at
  // serve time (preferred — the key never appears in argv). --api-key is
  // still accepted for ad-hoc use but exposes the key in process listings.
  let apiKey: string | undefined;
  if (options.apiKeyEnv !== undefined) {
    apiKey = process.env[options.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `Environment variable '${options.apiKeyEnv}' is not set or empty (required by --api-key-env).`,
      );
    }
  } else {
    apiKey = options.apiKey;
  }

  const { exports, moduleExports } = await loadAndDiscover(compileResult);
  const logger = createLogger("info");

  startHttpServer({
    exports,
    port,
    host: options.host,
    apiKey,
    logger,
    hasInterrupts: moduleExports.hasInterrupts as (data: unknown) => boolean,
    respondToInterrupts: moduleExports.respondToInterrupts as (
      interrupts: unknown[],
      responses: unknown[],
    ) => Promise<unknown>,
  });
}

type StandaloneHttpOptions = {
  port: number;
  host: string;
  apiKeyEnv: string;
};
type StandaloneMcpOptions = { serverName: string };

/**
 * Resolve an absolute path inside `dist/` from the currently running compiled
 * file. At runtime this file lives at `dist/lib/cli/serve.js`, so we go up two
 * levels to reach `dist/` and then join the requested path. The result is
 * normalized to forward slashes so it works as an import specifier on Windows
 * (esbuild does not accept backslash-separated import paths).
 */
function distPath(relativeToDist: string): string {
  const here = fileURLToPath(import.meta.url);
  const distDir = path.resolve(path.dirname(here), "..", "..");
  return toPosixPath(path.join(distDir, relativeToDist));
}

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function buildHttpEntrypoint(
  compiledAbsPath: string,
  compileResult: CompileResult,
  options: StandaloneHttpOptions,
): string {
  return renderStandaloneHttp({
    compiledModulePath: JSON.stringify(toPosixPath(compiledAbsPath)),
    discoveryPath: JSON.stringify(distPath("lib/serve/discovery.js")),
    httpAdapterPath: JSON.stringify(distPath("lib/serve/http/adapter.js")),
    loggerPath: JSON.stringify(distPath("lib/logger.js")),
    moduleId: JSON.stringify(compileResult.moduleId),
    exportedNodeNamesJson: JSON.stringify(compileResult.exportedNodeNames),
    interruptKindsByNameJson: JSON.stringify(compileResult.interruptKindsByName),
    defaultPort: JSON.stringify(String(options.port)),
    defaultHost: JSON.stringify(options.host),
    apiKeyEnv: JSON.stringify(options.apiKeyEnv),
  });
}

function buildMcpEntrypoint(
  compiledAbsPath: string,
  compileResult: CompileResult,
  options: StandaloneMcpOptions,
  serverVersion: string,
): string {
  return renderStandaloneMcp({
    compiledModulePath: JSON.stringify(toPosixPath(compiledAbsPath)),
    discoveryPath: JSON.stringify(distPath("lib/serve/discovery.js")),
    mcpAdapterPath: JSON.stringify(distPath("lib/serve/mcp/adapter.js")),
    policyStorePath: JSON.stringify(distPath("lib/serve/policyStore.js")),
    moduleId: JSON.stringify(compileResult.moduleId),
    exportedNodeNamesJson: JSON.stringify(compileResult.exportedNodeNames),
    interruptKindsByNameJson: JSON.stringify(compileResult.interruptKindsByName),
    serverName: JSON.stringify(options.serverName),
    serverVersion: JSON.stringify(serverVersion),
  });
}

async function generateStandalone(
  mode: "http" | "mcp",
  compileResult: CompileResult,
  originalFile: string,
  options: StandaloneHttpOptions | StandaloneMcpOptions,
): Promise<void> {
  const baseName = path.basename(originalFile, ".agency");
  const outfile = baseName + ".server.js";
  const compiledAbsPath = path.resolve(compileResult.outputPath);
  const entrypointPath = path.join(
    path.dirname(compiledAbsPath),
    `${baseName}.standalone-entry.mjs`,
  );

  const entrypointSource =
    mode === "http"
      ? buildHttpEntrypoint(
          compiledAbsPath,
          compileResult,
          options as StandaloneHttpOptions,
        )
      : buildMcpEntrypoint(
          compiledAbsPath,
          compileResult,
          options as StandaloneMcpOptions,
          VERSION,
        );

  fs.writeFileSync(entrypointPath, entrypointSource);

  let bundleSucceeded = false;
  try {
    await esbuild.build({
      entryPoints: [entrypointPath],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      external: [
        "node-llama-cpp",
        "node-llama-cpp/*",
        "@node-llama-cpp/*",
        "@reflink/*",
      ],
      banner: {
        js:
          '// Generated by Agency — standalone ' +
          mode +
          ' server\n' +
          'import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);',
      },
    });
    bundleSucceeded = true;
  } finally {
    // Always remove the temp entrypoint we created.
    safeUnlink(entrypointPath);
    // Only delete the intermediate compiled JS on success, and only if the
    // basename matches what compile() would produce (defends against an
    // accidentally-misconfigured outputPath pointing at a hand-written file).
    if (
      bundleSucceeded &&
      path.basename(compiledAbsPath) === `${baseName}.js`
    ) {
      safeUnlink(compiledAbsPath);
    }
  }

  console.log(`Standalone ${mode} server written to ${outfile}`);
}

function safeUnlink(p: string): void {
  if (!fs.existsSync(p)) return;
  try {
    fs.unlinkSync(p);
  } catch (err) {
    console.warn(
      `Failed to remove temporary file ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
