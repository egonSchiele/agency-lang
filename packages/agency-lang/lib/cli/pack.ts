import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";
import { AgencyConfig } from "@/config.js";
import { compile } from "./commands.js";

// Locate this package's install root by walking up from this module's
// location until we find a package.json whose name is "agency-lang".
// Works for both the built `dist/lib/cli/pack.js` and the dev-tree
// `lib/cli/pack.ts` paths.
function agencyLangInstallRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const pkgJson = path.join(dir, "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
        if (parsed.name === "agency-lang") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate agency-lang package root");
    }
    dir = parent;
  }
}

export type PackTarget = "node";

export type PackOptions = {
  config: AgencyConfig;
  inputFile: string;
  outputFile: string;
  target: PackTarget;
};

const SHEBANG = "#!/usr/bin/env node\n";

// Only Node built-ins are kept external; everything else (agency-lang,
// smoltalk, zod, user .agency imports, etc.) is bundled into the output
// so the result runs anywhere Node is available without an install.
const NODE_BUILTINS = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
  "node:*",
];

export async function pack(opts: PackOptions): Promise<void> {
  // 1. Compile the .agency file to .js using the existing pipeline.
  //    We write to a sibling temp file so relative paths inside the user's
  //    source dir continue to resolve the same way they would for `compile`.
  const tmpJs = opts.inputFile.replace(/\.agency$/, ".__pack__.js");
  const compiled = compile(opts.config, opts.inputFile, tmpJs);
  if (!compiled) {
    throw new Error(`compile failed for ${opts.inputFile}`);
  }

  try {
    // 2. Bundle with esbuild — inline agency-lang, smoltalk, zod, and any
    //    transitive .js imports into one ESM file. The user's working
    //    directory may have no node_modules, so explicitly tell esbuild to
    //    resolve bare specifiers from agency-lang's install location.
    const installRoot = agencyLangInstallRoot();
    const result = await build({
      entryPoints: [compiled],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      write: false,
      outfile: opts.outputFile,
      external: NODE_BUILTINS,
      nodePaths: [
        path.dirname(installRoot), // the directory containing agency-lang/
        path.join(installRoot, "node_modules"), // its own deps
      ],
      // Some transitive CJS deps call `require("child_process")` etc.
      // esbuild's bundler can't statically rewrite those for ESM output,
      // so it emits a runtime shim that throws "Dynamic require ...".
      // Replace that with a real createRequire so they work.
      banner: {
        js: [
          "// Built by `agency pack`",
          'import { createRequire as __pack_createRequire } from "node:module";',
          "const require = __pack_createRequire(import.meta.url);",
        ].join("\n"),
      },
      logLevel: "silent",
    });

    if (result.outputFiles.length !== 1) {
      throw new Error(
        `expected exactly one output file from esbuild, got ${result.outputFiles.length}`,
      );
    }

    const outDir = path.dirname(path.resolve(opts.outputFile));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(opts.outputFile, SHEBANG + result.outputFiles[0].text, {
      mode: 0o755,
    });
  } finally {
    if (fs.existsSync(tmpJs)) fs.unlinkSync(tmpJs);
  }
}
