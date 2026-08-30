/**
 * The sandboxed compile entry point: validate the untrusted closure, then
 * compile it from the validated mirror. This is the boundary where thrown
 * validation errors become CompileResult failures — the stdlib caller never
 * receives a throw.
 */
import * as fs from "fs";
import * as path from "path";
import { CompileResult } from "./compile.js";
import { ClosureEntry, ClosureValidationError, validateClosure } from "./closureValidator.js";
import { compileValidatedClosure } from "./compileValidatedClosure.js";

export { compileValidatedClosure } from "./compileValidatedClosure.js";

export type CompileSandboxedArgs = {
  entry: ClosureEntry;
  /** Confinement boundary for local imports. "" = no local imports possible. */
  dir: string;
  /** Enforce the reviewed JS-globals allowlist. Only `--agency-only` sets this;
   *  the trusted runtime fork path leaves it off. See compileValidatedClosure. */
  enforceJsGlobals?: boolean;
};

export function compileSandboxed(args: CompileSandboxedArgs): CompileResult {
  try {
    const closure = validateClosure({ entry: args.entry, dir: args.dir });
    return compileValidatedClosure(closure, { enforceJsGlobals: args.enforceJsGlobals });
  } catch (e) {
    if (e instanceof ClosureValidationError) {
      return { success: false, errors: e.violations };
    }
    return { success: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

export type AgencyOnlyCompile = { ok: true; scriptPath: string } | { ok: false; errors: string[] };

/** `--agency-only`: compile `sourceFile` through the validator and write the
 *  result beside the sources, `<name>.js` next to each `<name>.agency`, the
 *  same layout `compile()` produces. A refusal is returned, not thrown. */
export function compileAgencyOnly(sourceFile: string): AgencyOnlyCompile {
  const absolute = path.resolve(sourceFile);
  const dir = path.dirname(absolute);
  const result = compileSandboxed({
    entry: { file: path.basename(absolute) },
    dir,
    enforceJsGlobals: true,
  });
  if (!result.success) return { ok: false, errors: result.errors };
  for (const [relPath, code] of Object.entries(result.modules ?? {})) {
    fs.writeFileSync(path.join(dir, relPath), code);
  }
  const scriptPath = absolute.replace(/\.agency$/, ".js");
  fs.writeFileSync(scriptPath, result.code);
  return { ok: true, scriptPath };
}
