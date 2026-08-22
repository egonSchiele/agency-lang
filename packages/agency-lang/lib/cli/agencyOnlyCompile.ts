/**
 * `--agency-only`: compile one source file through the sandboxed closure
 * validator (lib/compiler/compileSandboxed.ts) and lay the result out on disk
 * the way the runtime does for run() subprocesses.
 *
 * The validator refuses anything in the import closure that is not Agency
 * source: TypeScript/JavaScript files, Node built-ins, `pkg::` packages,
 * compile-time splices, and local imports that are absolute, leave the
 * source's directory, or go through a symlink. A refusal comes back as data
 * (`ok: false`) because for the callers here — the test runner grading
 * agent-written code, `agency run` on an untrusted file — "it does not
 * compile" is an ordinary outcome, not a reason to kill the process.
 */
import * as path from "path";
import { compileSandboxed } from "../compiler/compileSandboxed.js";
import { materializeCompiledScript } from "../runtime/ipc.js";

export type AgencyOnlyCompile =
  | {
      ok: true;
      /** The entry script, inside a fresh `.agency-tmp/<id>/` directory.
       *  Remove it with `removeCompiledScriptDir` when the run is over. */
      scriptPath: string;
    }
  | { ok: false; errors: string[] };

export function compileAgencyOnly(sourceFile: string): AgencyOnlyCompile {
  const absolute = path.resolve(sourceFile);
  const result = compileSandboxed({
    entry: { file: path.basename(absolute) },
    dir: path.dirname(absolute),
  });
  if (!result.success) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, scriptPath: materializeCompiledScript(result) };
}
