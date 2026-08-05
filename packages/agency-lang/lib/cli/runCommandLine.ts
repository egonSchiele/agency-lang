/**
 * Decides where agency's command line ends and the program's begins.
 *
 * `agency run --policy strict greet.agency --name alice` carries two command
 * lines. The rule is position: agency's flags come before the filename, and
 * everything after it belongs to the program. Commander cannot express that on
 * its own — `passThroughOptions` would, but it requires positional parsing on
 * the root command, which stops every nested command from seeing its parent's
 * options (`agency label ingest --store x` fails outright).
 *
 * So the boundary is drawn before commander runs, by inserting `--` after the
 * filename. `agency agent` already does this with `injectAgentSeparator`; this
 * is the same idea where the boundary is a filename rather than the subcommand.
 */
export type CliFlag = {
  short?: string;
  long?: string;
  /** Whether the flag consumes the token after it, as `--policy strict` does. */
  takesValue: boolean;
};

export type PreparedArgv = {
  /** argv with the separator inserted, ready for commander. */
  argv: string[];
  /** An agency flag that went to the program because of where it was written.
   *  Position still decides — this only says so out loud. */
  warning?: string;
};

export function insertProgramSeparator(
  argv: string[],
  flags: CliFlag[],
): PreparedArgv {
  const subcommand = findSubcommandIndex(argv);
  if (subcommand === -1 || argv[subcommand] !== "run") return { argv };

  let i = subcommand + 1;
  while (i < argv.length) {
    const token = argv[i];
    // The user drew the line themselves.
    if (token === "--") return { argv };
    if (!isFlag(token)) break;
    i += tokensConsumedBy(token, flags);
  }
  // No filename: commander reports that better than we can.
  if (i >= argv.length) return { argv };

  const rest = argv.slice(i + 1);
  if (rest.length === 0 || rest[0] === "--") return { argv };

  const claimed = rest.flatMap(flagNamesIn).find((name) =>
    flags.some((flag) => flag.short === name || flag.long === name),
  );
  return {
    argv: [...argv.slice(0, i + 1), "--", ...rest],
    warning:
      claimed === undefined ? undefined : misplacedFlagWarning(claimed, argv[i]),
  };
}

export function misplacedFlagWarning(flag: string, input: string): string {
  return [
    `Warning: ${flag} went to your program, not to agency.`,
    `  Agency flags go before the filename: agency run ${flag} ... ${input}`,
    `  Write -- before it to silence this:  agency run ${input} -- ${flag} ...`,
  ].join("\n");
}

/**
 * Walks past `node`, the script path, and any leading top-level options
 * (-v/--verbose, -c/--config <path>) to find the subcommand token.
 * Returns -1 if no subcommand is present.
 */
const TOP_LEVEL_BOOLEAN_FLAGS = ["-v", "--verbose"];
const TOP_LEVEL_VALUE_FLAGS = ["-c", "--config"];

export function findSubcommandIndex(argv: string[]): number {
  // argv[0] = node, argv[1] = script path. Subcommand search starts at 2.
  let i = 2;
  while (i < argv.length) {
    const token = argv[i];
    if (TOP_LEVEL_BOOLEAN_FLAGS.includes(token)) {
      i += 1;
      continue;
    }
    if (TOP_LEVEL_VALUE_FLAGS.includes(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("--config=") || token.startsWith("--verbose=")) {
      i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

/**
 * Every flag name a token could be naming. Commander accepts four spellings,
 * and a guard that only understands the plainest one lets the others through
 * silently:
 *
 *   --policy strict   --policy=strict   -c file.json   -cfile.json   -iv
 */
function flagNamesIn(token: string): string[] {
  if (!isFlag(token)) return [];
  if (token.startsWith("--")) {
    const equals = token.indexOf("=");
    return [equals === -1 ? token : token.slice(0, equals)];
  }
  // A short token is either one flag, one flag with its value attached, or a
  // cluster of single-letter flags. Naming every letter covers all three.
  return [...token.slice(1)].map((letter) => `-${letter}`);
}

function findFlag(name: string, flags: CliFlag[]): CliFlag | undefined {
  return flags.find((flag) => flag.short === name || flag.long === name);
}

function tokensConsumedBy(token: string, flags: CliFlag[]): number {
  if (token.startsWith("--")) {
    if (token.includes("=")) return 1;
    return findFlag(token, flags)?.takesValue === true ? 2 : 1;
  }
  const letters = [...token.slice(1)];
  const first = findFlag(`-${letters[0]}`, flags);
  // `-cfile.json`: the value is attached, so the next token is not part of it.
  if (letters.length > 1 && first?.takesValue === true) return 1;
  const last = findFlag(`-${letters[letters.length - 1]}`, flags);
  return last?.takesValue === true ? 2 : 1;
}
