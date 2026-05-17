import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { build, type Plugin } from "esbuild";
import { AgencyConfig } from "@/config.js";
import { SymbolTable } from "@/symbolTable.js";
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

// esbuild plugin that resolves `agency-lang` and `agency-lang/<sub>`
// imports against the agency-lang package's own `package.json`. This is
// the only mechanism we use to teach esbuild where agency-lang lives —
// we intentionally do NOT use `nodePaths`, because that would also let
// esbuild silently bundle any globally-installed sibling package the
// user happens to (mis-)import, making the output non-reproducible.
//
// Transitive dependencies of agency-lang (zod, smoltalk, etc.) are
// resolved by esbuild's normal walk from the resolved agency-lang
// files' on-disk locations.
function agencyLangResolverPlugin(installRoot: string): Plugin {
  const req = createRequire(path.join(installRoot, "package.json"));
  return {
    name: "agency-lang-resolver",
    setup(build) {
      build.onResolve({ filter: /^agency-lang(\/.*)?$/ }, (args) => {
        try {
          return { path: req.resolve(args.path) };
        } catch (err) {
          return {
            errors: [
              {
                text: `agency pack: could not resolve "${args.path}" from agency-lang at ${installRoot}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      });
    },
  };
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

// Walk the symbol table from the entry and collect every .agency file
// reachable. These are the locations where `compile()` will produce
// transitive .js sidecars next to the user's source.
function reachableAgencyFiles(entry: string, config: AgencyConfig): string[] {
  try {
    const st = SymbolTable.build(entry, config);
    return st.filePaths().filter((p) => p.endsWith(".agency"));
  } catch {
    // If symbol-table building fails, the subsequent compile will fail
    // with a more useful message; just skip the cleanup snapshot.
    return [];
  }
}

export async function pack(opts: PackOptions): Promise<void> {
  // 1. Reject inputs whose extension isn't `.agency`. Otherwise the
  //    tmp-file derivation below could end up writing over the input
  //    and then deleting it in `finally`.
  if (!opts.inputFile.endsWith(".agency")) {
    throw new Error(
      `agency pack: input file must end in .agency (got ${opts.inputFile})`,
    );
  }
  if (!fs.existsSync(opts.inputFile)) {
    throw new Error(`agency pack: input file not found: ${opts.inputFile}`);
  }

  // 2. Snapshot which sibling .js files exist BEFORE compile runs. We
  //    use this to clean up only the files compile creates — a
  //    user-authored .js that already existed must never be deleted.
  const reachable = reachableAgencyFiles(opts.inputFile, opts.config);
  const siblingJsPaths = reachable.map((p) => p.replace(/\.agency$/, ".js"));
  const preExistingJs = new Set(
    siblingJsPaths.filter((p) => fs.existsSync(p)),
  );

  // 3. Compile the entry next to its source under a `.__pack__.js`
  //    suffix so we never collide with a user-authored `<name>.js`.
  //    Recursive .agency imports get compiled next to their sources
  //    (the normal `compile` behavior) — those are tracked above and
  //    cleaned up in `finally` below so the bundled artifact is the
  //    only file the user sees afterwards.
  const entryOutput = opts.inputFile.replace(/\.agency$/, ".__pack__.js");
  try {
    const compiled = compile(opts.config, opts.inputFile, entryOutput);
    if (!compiled) {
      throw new Error(`agency pack: compile failed for ${opts.inputFile}`);
    }

    // 4. Bundle with esbuild. Only Node built-ins stay external; the
    //    agency-lang package and its transitive deps inline. The
    //    resolver plugin handles `agency-lang*` specifiers using
    //    agency-lang's own require resolution — no nodePaths, so we
    //    cannot accidentally pull in globally-installed user packages.
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
      plugins: [agencyLangResolverPlugin(installRoot)],
      // Some transitive CJS deps call `require("child_process")` etc.
      // esbuild can't statically rewrite those for ESM output, so it
      // emits a runtime shim that throws "Dynamic require ...".
      // Install a real createRequire so they work.
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
        `agency pack: expected exactly one output file from esbuild, got ${result.outputFiles.length}`,
      );
    }

    // 5. Write the bundle. mode on writeFileSync only takes effect when
    //    the file is created — if the user re-packs over an existing
    //    file, Node preserves the old permissions. chmod explicitly so
    //    the output is always executable.
    const outDir = path.dirname(path.resolve(opts.outputFile));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(opts.outputFile, SHEBANG + result.outputFiles[0].text, {
      mode: 0o755,
    });
    fs.chmodSync(opts.outputFile, 0o755);
  } finally {
    // 6. Tidy up: the entry `.__pack__.js`, plus any sibling .js files
    //    compile() created next to the user's source files. We never
    //    touch a sibling .js that already existed before we ran.
    if (fs.existsSync(entryOutput)) {
      try {
        fs.unlinkSync(entryOutput);
      } catch {
        /* best-effort */
      }
    }
    const absOutput = path.resolve(opts.outputFile);
    for (const p of siblingJsPaths) {
      // Never delete:
      //  - a sibling that pre-existed (it's the user's file)
      //  - the pack output itself (it might coincidentally share a name)
      if (
        preExistingJs.has(p) ||
        path.resolve(p) === absOutput ||
        !fs.existsSync(p)
      ) {
        continue;
      }
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort */
      }
    }
  }
}
