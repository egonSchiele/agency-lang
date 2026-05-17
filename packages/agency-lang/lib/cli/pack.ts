import * as fs from "fs";
import * as path from "path";
import { builtinModules, createRequire } from "module";
import { fileURLToPath } from "url";
import { build, type Plugin } from "esbuild";
import { AgencyConfig } from "@/config.js";
import { findPackageRoot } from "@/importPaths.js";
import { SymbolTable } from "@/symbolTable.js";
import { compile } from "./commands.js";

// Locate this package's install root by walking up from this module's
// location until we find a package.json whose name is "agency-lang".
// Works for both the built `dist/lib/cli/pack.js` and the dev-tree
// `lib/cli/pack.ts` paths.
function agencyLangInstallRoot(): string {
  return findPackageRoot(
    path.dirname(fileURLToPath(import.meta.url)),
    "agency-lang",
  );
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
export type PackFormat = "esm" | "cjs";

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
// Derived from `module.builtinModules` so it always tracks the running
// Node version with no hand-maintained list to keep in sync.
const NODE_BUILTINS = [...builtinModules, "node:*"];

// Defaults used when `config.pack` does not override them.
const DEFAULT_FORMAT: PackFormat = "esm";
const DEFAULT_NODE_TARGET = "node20";

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
    const packCfg = opts.config.pack ?? {};
    const format: PackFormat = packCfg.format ?? DEFAULT_FORMAT;
    const targetVersion = packCfg.target ?? DEFAULT_NODE_TARGET;
    const externals = [...NODE_BUILTINS, ...(packCfg.external ?? [])];
    const verbose = !!opts.config.verbose;
    if (verbose) {
      console.error(
        `agency pack: bundling ${opts.inputFile} (format=${format}, target=${targetVersion}, installRoot=${installRoot})`,
      );
    }
    // Some transitive CJS deps call `require("child_process")` etc.
    // esbuild can't statically rewrite those for ESM output, so it
    // emits a runtime shim that throws "Dynamic require ...".
    // Install a real createRequire so they work. CJS output does not
    // need the shim because `require` is already available there.
    const banner =
      format === "esm"
        ? {
            js: [
              "// Built by `agency pack`",
              'import { createRequire as __pack_createRequire } from "node:module";',
              "const require = __pack_createRequire(import.meta.url);",
            ].join("\n"),
          }
        : { js: "// Built by `agency pack`" };
    const result = await build({
      entryPoints: [compiled],
      bundle: true,
      platform: "node",
      format,
      target: targetVersion,
      write: false,
      outfile: opts.outputFile,
      external: externals,
      plugins: [agencyLangResolverPlugin(installRoot)],
      banner,
      logLevel: verbose ? "info" : "silent",
    });

    if (result.outputFiles.length !== 1) {
      const paths = result.outputFiles.map((f) => f.path).join(", ");
      throw new Error(
        `agency pack: expected exactly one output file from esbuild, got ${result.outputFiles.length}: [${paths}]`,
      );
    }

    // 5. Write the bundle and force executable permissions. The `mode`
    //    option on writeFileSync is honored only when Node creates the
    //    file; if we're overwriting an existing non-executable file
    //    Node keeps the old permissions, so we chmod explicitly
    //    afterward to guarantee the output is always runnable as
    //    `./bundle.mjs`.
    const outDir = path.dirname(path.resolve(opts.outputFile));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(opts.outputFile, SHEBANG + result.outputFiles[0].text, {
      mode: 0o755,
    });
    fs.chmodSync(opts.outputFile, 0o755);
    if (verbose) {
      const size = fs.statSync(opts.outputFile).size;
      console.error(
        `agency pack: wrote ${opts.outputFile} (${size} bytes, mode 0755)`,
      );
    }
  } finally {
    // 6. Tidy up: the entry `.__pack__.js`, plus any sibling .js files
    //    compile() created next to the user's source files. We never
    //    touch a sibling .js that already existed before we ran.
    tryRemove(entryOutput);
    const absOutput = path.resolve(opts.outputFile);
    for (const p of siblingJsPaths) {
      // Never delete:
      //  - a sibling that pre-existed (it's the user's file)
      //  - the pack output itself (it might coincidentally share a name)
      if (preExistingJs.has(p) || path.resolve(p) === absOutput) {
        continue;
      }
      tryRemove(p);
    }
  }
}

// Best-effort cleanup of a generated file. Refuses to follow into a
// directory (a `.js` directory next to a `.agency` source would be the
// user's, not ours), and surfaces real failures (permission denied,
// busy file, etc.) as warnings rather than silently swallowing them.
function tryRemove(p: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch (err: unknown) {
    // ENOENT is fine — nothing to clean up.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.error(
      `agency pack: warning: could not stat ${p} for cleanup: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (stat.isDirectory()) {
    // Don't recurse into directories — that's almost certainly user data.
    return;
  }
  try {
    fs.unlinkSync(p);
  } catch (err) {
    console.error(
      `agency pack: warning: could not remove ${p}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
