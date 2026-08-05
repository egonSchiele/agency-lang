/**
 * Works out which of the words after the filename belong to the program, and
 * catches an agency flag that landed on the wrong side of the filename.
 *
 * `agency run` forwards everything after the input file to the program, so
 * commander no longer rejects flags it does not recognize there — it hands
 * them over. That is the point, but it means a misplaced `--max-cost` would
 * quietly stop capping spend instead of failing. Anything before a `--` is
 * therefore checked against agency's own flags; anything after it the user has
 * explicitly claimed for the program, so it passes through untouched.
 */
export type ForwardedArgs = {
  /** What the program receives in argv, with one `--` separator removed. */
  args: string[];
  /** An agency flag found before any `--`. */
  misplaced?: string;
};

export function resolveForwardedArgs(
  nodeArgs: string[],
  agencyFlags: string[],
): ForwardedArgs {
  const separator = nodeArgs.indexOf("--");
  const claimed = separator === -1 ? nodeArgs : nodeArgs.slice(0, separator);
  const args =
    separator === -1
      ? nodeArgs
      : [...claimed, ...nodeArgs.slice(separator + 1)];
  const misplaced = claimed
    .map(flagNameOf)
    .find((name) => agencyFlags.includes(name));
  return misplaced === undefined ? { args } : { args, misplaced };
}

export function misplacedFlagMessage(flag: string, input: string): string {
  return [
    `${flag} is an agency flag, not an argument for your program.`,
    ``,
    `  Put it before the file:      agency run ${flag} ... ${input}`,
    `  Or hand it to the program:   agency run ${input} -- ${flag} ...`,
  ].join("\n");
}

/** `--max-cost=5` names the same flag as `--max-cost 5`. */
function flagNameOf(arg: string): string {
  const equals = arg.indexOf("=");
  return equals === -1 ? arg : arg.slice(0, equals);
}
