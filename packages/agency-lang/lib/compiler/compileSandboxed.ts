/**
 * The sandboxed compile entry point: validate the untrusted closure, then
 * compile it from the validated mirror. This is the boundary where thrown
 * validation errors become CompileResult failures — the stdlib caller never
 * receives a throw.
 */
import { CompileResult } from "./compile.js";
import { ClosureEntry, ClosureValidationError, validateClosure } from "./closureValidator.js";
import { compileValidatedClosure } from "./compileValidatedClosure.js";

export { compileValidatedClosure } from "./compileValidatedClosure.js";

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
