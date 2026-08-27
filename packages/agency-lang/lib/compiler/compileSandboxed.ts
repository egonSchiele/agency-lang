/**
 * The sandboxed compile entry point: validate the untrusted closure, then
 * compile it from the validated mirror. This is the boundary where thrown
 * validation errors become CompileResult failures — the stdlib caller never
 * receives a throw.
 */
import * as fs from "fs";
import * as path from "path";
import { CompileResult, TypeCheckReport } from "./compile.js";
import { ClosureEntry, ClosureValidationError, validateClosure } from "./closureValidator.js";
import { compileValidatedClosure, typeCheckValidatedClosure } from "./compileValidatedClosure.js";

export { compileValidatedClosure } from "./compileValidatedClosure.js";

/** Type-check an untrusted closure the way `compileSandboxed` compiles one:
 *  validate it, then check the entry from the mirror so its local imports
 *  resolve. A validation refusal throws an Error listing the violations;
 *  the stdlib's `try` turns it into a failure. */
export function typecheckSandboxed(args: CompileSandboxedArgs): TypeCheckReport {
  try {
    return typeCheckValidatedClosure(validateClosure({ entry: args.entry, dir: args.dir }));
  } catch (e) {
    if (e instanceof ClosureValidationError) {
      throw new Error(e.violations.join("\n"));
    }
    throw e;
  }
}

export type CompileSandboxedArgs = {
  entry: ClosureEntry;
  /** Confinement boundary for local imports. "" = no local imports possible. */
  dir: string;
};

export function compileSandboxed(args: CompileSandboxedArgs): CompileResult {
  try {
    const closure = validateClosure({ entry: args.entry, dir: args.dir });
    return compileValidatedClosure(closure);
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
  const result = compileSandboxed({ entry: { file: path.basename(absolute) }, dir });
  if (!result.success) return { ok: false, errors: result.errors };
  for (const [relPath, code] of Object.entries(result.modules ?? {})) {
    fs.writeFileSync(path.join(dir, relPath), code);
  }
  const scriptPath = absolute.replace(/\.agency$/, ".js");
  fs.writeFileSync(scriptPath, result.code);
  return { ok: true, scriptPath };
}
