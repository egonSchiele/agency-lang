import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import process from "process";
import { pathToFileURL } from "url";
import { compile, loadConfig } from "./commands.js";
import { SymbolTable } from "../symbolTable.js";
import { discoverExports } from "../serve/discovery.js";
import { createMcpHandler, startStdioServer } from "../serve/mcp/adapter.js";
import { startHttpServer } from "../serve/http/adapter.js";
import { createLogger } from "../logger.js";
import { VERSION } from "../version.js";
import type { ExportedItem } from "../serve/types.js";
import * as esbuild from "esbuild";

type CompileResult = {
  outputPath: string;
  moduleId: string;
  exportedNodeNames: string[];
  exportedConstantNames: string[];
};

function compileForServe(file: string): CompileResult {
  const config = loadConfig();
  const absoluteFile = path.resolve(file);
  const symbolTable = SymbolTable.build(absoluteFile, config);

  const outputPath = compile(config, file, undefined, { symbolTable });
  if (!outputPath) {
    throw new Error(`Compilation failed for ${file}`);
  }

  const symbols = Object.values(symbolTable.getFile(absoluteFile) ?? {});
  const exportedNodeNames = symbols
    .filter((sym) => sym.kind === "node" && sym.exported)
    .map((sym) => sym.name);
  const exportedConstantNames = symbols
    .filter((sym) => sym.kind === "constant" && sym.exported)
    .map((sym) => sym.name);

  const moduleId = path.relative(process.cwd(), absoluteFile);
  return { outputPath, moduleId, exportedNodeNames, exportedConstantNames };
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
    exportedConstantNames: compileResult.exportedConstantNames,
  });

  return { exports, moduleExports };
}

export async function serveMcp(
  file: string,
  options: { name?: string; standalone?: boolean },
): Promise<void> {
  const compileResult = compileForServe(file);

  if (options.standalone) {
    const serverName = options.name ?? path.basename(file, ".agency");
    await generateStandalone("mcp", compileResult, file, { name: serverName });
    return;
  }

  const { exports } = await loadAndDiscover(compileResult);

  const serverName = options.name ?? path.basename(file, ".agency");
  const handler = createMcpHandler({
    serverName,
    serverVersion: VERSION,
    exports,
  });

  startStdioServer(handler);
}

export async function serveHttp(
  file: string,
  options: { port?: string; apiKey?: string; apiKeyEnv?: string; standalone?: boolean },
): Promise<void> {
  const compileResult = compileForServe(file);

  if (options.standalone) {
    await generateStandalone("http", compileResult, file, {
      port: options.port ?? "3545",
      apiKeyEnv: options.apiKeyEnv ?? "API_KEY",
    });
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

type StandaloneHttpOptions = { port: string; apiKeyEnv: string };
type StandaloneMcpOptions = { name: string };

// Resolve absolute path to a dist module so the generated entrypoint
// can import it without relying on the package.json exports map.
function distPath(relativeToDist: string): string {
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  // currentDir is dist/lib/cli — go up to dist/
  const distDir = path.resolve(currentDir, "../..");
  return path.join(distDir, relativeToDist);
}

function generateHttpEntrypoint(
  compiledBasename: string,
  compileResult: CompileResult,
  options: StandaloneHttpOptions,
): string {
  const { moduleId, exportedNodeNames, exportedConstantNames } = compileResult;
  const discovery = distPath("lib/serve/discovery.js");
  const httpAdapter = distPath("lib/serve/http/adapter.js");
  const logger = distPath("lib/logger.js");

  return `import * as mod from "./${compiledBasename}";
import { discoverExports } from ${JSON.stringify(discovery)};
import { startHttpServer } from ${JSON.stringify(httpAdapter)};
import { createLogger } from ${JSON.stringify(logger)};

const exports = discoverExports({
  toolRegistry: mod.__toolRegistry ?? {},
  moduleExports: mod,
  moduleId: ${JSON.stringify(moduleId)},
  exportedNodeNames: ${JSON.stringify(exportedNodeNames)},
  exportedConstantNames: ${JSON.stringify(exportedConstantNames)},
});

const port = parseInt(process.env.PORT ?? ${JSON.stringify(options.port)}, 10);
startHttpServer({
  exports,
  port,
  apiKey: process.env[${JSON.stringify(options.apiKeyEnv)}],
  logger: createLogger("info"),
  hasInterrupts: mod.hasInterrupts,
  respondToInterrupts: mod.respondToInterrupts,
});
`;
}

function generateMcpEntrypoint(
  compiledBasename: string,
  compileResult: CompileResult,
  options: StandaloneMcpOptions,
): string {
  const { moduleId, exportedNodeNames, exportedConstantNames } = compileResult;
  const discovery = distPath("lib/serve/discovery.js");
  const mcpAdapter = distPath("lib/serve/mcp/adapter.js");

  return `import * as mod from "./${compiledBasename}";
import { discoverExports } from ${JSON.stringify(discovery)};
import { createMcpHandler, startStdioServer } from ${JSON.stringify(mcpAdapter)};

const exports = discoverExports({
  toolRegistry: mod.__toolRegistry ?? {},
  moduleExports: mod,
  moduleId: ${JSON.stringify(moduleId)},
  exportedNodeNames: ${JSON.stringify(exportedNodeNames)},
  exportedConstantNames: ${JSON.stringify(exportedConstantNames)},
});

const handler = createMcpHandler({
  serverName: ${JSON.stringify(options.name)},
  serverVersion: "1.0.0",
  exports,
});
startStdioServer(handler);
`;
}

const STANDALONE_EXTERNALS = [
  "node-llama-cpp",
  "node-llama-cpp/*",
  "@node-llama-cpp/*",
  "@reflink/*",
];

async function generateStandalone(
  mode: "http" | "mcp",
  compileResult: CompileResult,
  originalFile: string,
  options: StandaloneHttpOptions | StandaloneMcpOptions,
): Promise<void> {
  const compiledPath = compileResult.outputPath;
  const compiledBasename = path.basename(compiledPath);
  const compiledDir = path.dirname(compiledPath);
  const outfile = path.basename(originalFile, ".agency") + ".server.js";

  const entrypoint =
    mode === "http"
      ? generateHttpEntrypoint(compiledBasename, compileResult, options as StandaloneHttpOptions)
      : generateMcpEntrypoint(compiledBasename, compileResult, options as StandaloneMcpOptions);

  const entrypointPath = path.join(compiledDir, `__standalone_entry_${Date.now()}.js`);
  writeFileSync(entrypointPath, entrypoint);

  try {
    await esbuild.build({
      entryPoints: [entrypointPath],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      external: STANDALONE_EXTERNALS,
      banner: {
        js: `import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);`,
      },
    });
    console.log(`Standalone server written to ${outfile}`);
  } finally {
    unlinkSync(entrypointPath);
    unlinkSync(compiledPath);
  }
}
