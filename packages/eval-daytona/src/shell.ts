import { SandboxCommandError, type ExecOptions, type Sandbox } from "./types.js";

const PLAIN_WORD = /^[A-Za-z0-9_./:=@-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One shell word. A plain word is left as it is; anything else is
 *  single-quoted, with each `'` written as `'\''`. */
export function quote(text: string): string {
  if (PLAIN_WORD.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The one place that turns `user`, `cwd` and `env` into a line. */
export function shellLine(command: string, options: ExecOptions = {}): string {
  const prefix: string[] = [];
  if (options.cwd !== undefined) {
    prefix.push(`cd ${quote(options.cwd)}`);
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`env name is not an identifier: ${name}`);
    }
    prefix.push(`export ${name}=${quote(value)}`);
  }
  // The subshell keeps a command holding `;` or `||` whole: without it,
  // `cd x && a || b` runs `b` after a failed `cd`, in the wrong directory.
  const line = prefix.length === 0 ? command : `${prefix.join(" && ")} && ( ${command} )`;
  if (options.user === undefined) {
    return line;
  }
  // `su` without `-` keeps the caller's exported variables.
  return `su ${quote(options.user)} -s /bin/bash -c ${quote(line)}`;
}

/** Runs a command that must succeed. Returns its output; a non-zero exit
 *  throws SandboxCommandError carrying the end of the output. */
export async function mustExec(
  sandbox: Sandbox,
  label: string,
  command: string,
  options: ExecOptions = {},
): Promise<string> {
  const result = await sandbox.exec(shellLine(command, options), {
    timeoutSec: options.timeoutSec,
  });
  if (result.exitCode !== 0) {
    throw new SandboxCommandError(label, result.exitCode, result.output);
  }
  return result.output;
}
