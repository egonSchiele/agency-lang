/**
 * Presentation for the misplaced-flag warning.
 *
 * `agency run greet.agency --max-cost 5` forwards `--max-cost` to the program
 * — that is the position rule working as designed — but a spend cap that
 * silently does nothing deserves a warning. The *decision* (which flag in the
 * program tail is agency-owned, and whether the user claimed the tail with
 * `--`) is made inside the vendored commander fork, which records it on the
 * boundary command as `boundaryInfo()`. This module only renders it.
 *
 * The tokenizer that used to live here (splitCommandLine and friends) is
 * gone: the boundary is drawn by the parser itself. See
 * docs/dev/vendored-commander.md.
 */
import type { Command } from "../vendor/commander/index.js";

export function misplacedFlagWarning(flag: string, input: string): string {
  return [
    `Warning: ${flag} went to your program, not to agency.`,
    `  Agency flags go before the filename: agency run ${flag} ... ${input}`,
    `  Write -- before it to silence this:  agency run ${input} -- ${flag} ...`,
  ].join("\n");
}

/** The rule-1 warning: an agency-owned flag in the program tail, unless the
 *  user drew the line with `--`. Provenance comes from the fork parser. */
export function warnMisplacedAgencyFlags(command: Command, input: string): string | undefined {
  const boundary = command.boundaryInfo();
  if (boundary === undefined || boundary.viaSeparator) {
    return undefined;
  }
  if (boundary.firstPathOwnedOption === undefined) {
    return undefined;
  }
  return misplacedFlagWarning(boundary.firstPathOwnedOption, input);
}
