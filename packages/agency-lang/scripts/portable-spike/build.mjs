// Bundle a compiled Agency program for an engine that is not Node.
//
// The bundle needs no `async` rewrite of its own. The compiler rewrites the
// program, and `make` rewrites the runtime (scripts/rewrite-async.mjs).
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const builtins = builtinModules.flatMap((m) => [m, "node:" + m]);

const NOT_PORTABLE = (process.env.SPIKE_STUB ?? "esbuild").split(",");

// Real, pure-JS stand-ins for the two Node modules that are used at load time.
const REAL = {
  process: `module.exports = globalThis.process;`,
  path: readFileSync(join(here, "path-lite.cjs"), "utf-8"),
  url: `module.exports = { fileURLToPath: (u) => String(u).replace(/^file:\\/\\//, ""), pathToFileURL: (p) => new URL("file://" + p), URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams };`,
};

const require = createRequire(import.meta.url);
function exportNames(name) {
  try {
    return Object.keys(require(name)).filter((k) => k !== "default");
  } catch {
    return [];
  }
}

// Every other Node module becomes an object whose functions throw when
// called, and record the call. Reading a property is fine; only a call fails.
function stubSource(name) {
  return `
    const calls = (globalThis.__nodeStubCalls = globalThis.__nodeStubCalls || {});
    const atLoad = (globalThis.__nodeStubAtLoad = globalThis.__nodeStubAtLoad || {});
    function stub(path) {
      return new Proxy(function () {}, {
        get(target, key) {
          if (key === "__esModule") return false;
          // A constant used in arithmetic at load time (fs.constants.O_NONBLOCK | ...).
          if (key === Symbol.toPrimitive || key === "valueOf" || key === "toString") {
            return () => { atLoad["read " + path] = (atLoad["read " + path] || 0) + 1; return 0; };
          }
          if (typeof key === "symbol" || key === "then") return undefined;
          if (key === "prototype") return target.prototype;
          return stub(path + "." + String(key));
        },
        // While modules are loading, a call is recorded and answered with
        // another stub, so one run lists every load-time use. Once the entry
        // sets __nodeStubStrict, a call throws.
        apply() {
          // There is no file system. Reads fail the way a missing file
          // fails, at load time too, so callers take their own fallback.
          if (/^fs\.(statSync|lstatSync|readFileSync|realpathSync|readdirSync|accessSync)$/.test(path)) {
            const record = globalThis.__nodeStubStrict ? calls : atLoad;
            record[path] = (record[path] || 0) + 1;
            const error = new Error("ENOENT: no file system here: " + path); error.code = "ENOENT"; throw error;
          }
          if (path === "fs.existsSync") {
            const record = globalThis.__nodeStubStrict ? calls : atLoad;
            record[path] = (record[path] || 0) + 1;
            return false;
          }
          if (!globalThis.__nodeStubStrict) { atLoad[path] = (atLoad[path] || 0) + 1; return stub(path + "()"); }
          calls[path] = (calls[path] || 0) + 1; throw new Error("Node API not available here: " + path);
        },
        construct() {
          if (!globalThis.__nodeStubStrict) { atLoad["new " + path] = (atLoad["new " + path] || 0) + 1; return stub("new " + path); }
          calls["new " + path] = (calls["new " + path] || 0) + 1; throw new Error("Node API not available here: new " + path);
        },
      });
    }
    // esbuild copies a CommonJS module's own property names to build the
    // namespace for named imports, so the names must really exist.
    const exported = {};
    for (const key of ${JSON.stringify(exportNames(name))}) exported[key] = stub(${JSON.stringify(name)} + "." + key);
    exported.default = exported;
    module.exports = exported;
  `;
}

const nodeStubs = {
  name: "node-stubs",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      // The prelude every program imports (stdlib/index.js) reaches the
      // compiler through lib/stdlib/agency.js, and the compiler loads esbuild.
      if (builtins.includes(args.path) || NOT_PORTABLE.includes(args.path)) {
        return { path: args.path.replace(/^node:/, ""), namespace: "node-stub" };
      }
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => ({
      contents: REAL[args.path] ?? stubSource(args.path),
      loader: "js",
    }));
  },
};

const agencyResolve = {
  name: "agency-resolve",
  setup(b) {
    b.onResolve({ filter: /^agency-lang$/ }, () => ({ path: join(here, "agency-lang-shim.js") }));
    b.onResolve({ filter: /^agency-lang\/runtime$/ }, () => ({ path: join(root, "dist/lib/runtime/index.js") }));
    b.onResolve({ filter: /^agency-lang\/zod$/ }, () => ({ path: join(root, "dist/lib/zod.js") }));
    b.onResolve({ filter: /^agency-lang\/stdlib-lib\// }, (args) => ({
      path: join(root, "dist/lib/stdlib", args.path.replace("agency-lang/stdlib-lib/", "")),
    }));
    b.onResolve({ filter: /^agency-lang\/stdlib\// }, (args) => ({
      path: join(root, "stdlib", args.path.replace("agency-lang/stdlib/", "")),
    }));
  },
};

const PROCESS_GLOBAL = `globalThis.process = globalThis.process || { env: {}, argv: [], execArgv: [], cwd: () => "/", platform: "browser", versions: {}, on() {}, off() {}, once() {}, emitWarning() {}, stderr: { write() {} }, stdout: { write() {} }, exit() {}, nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)) };`;

const result = await build({
  entryPoints: [join(here, "entry.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: join(here, "bundle.js"),
  define: { "import.meta.url": JSON.stringify("file:///agent.js"), global: "globalThis" },
  plugins: [agencyResolve, nodeStubs],
  // 22 bundled modules read the \`process\` global without importing it.
  banner: { js: PROCESS_GLOBAL },
  metafile: true,
  logLevel: "warning",
  logLimit: 20,
});

const inputs = Object.keys(result.metafile.inputs);
const stubbed = inputs.filter((i) => i.startsWith("node-stub:")).map((i) => i.replace("node-stub:", ""));
writeFileSync(join(here, "meta.json"), JSON.stringify(result.metafile));
const bytes = Object.values(result.metafile.outputs)[0].bytes;
writeFileSync(join(here, "bundle-report.json"), JSON.stringify({ bytes, modules: inputs.length, nodeModulesStubbed: stubbed.sort() }, null, 2));
console.log(`bundle: ${(bytes / 1e6).toFixed(1)} MB from ${inputs.length} modules; Node modules stood in for: ${stubbed.sort().join(", ")}`);
