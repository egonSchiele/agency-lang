/**
 * Decides where agency's command line ends and the program's begins.
 *
 * `agency run --policy strict greet.agency --name alice` carries two command
 * lines. The rule is position: agency's flags and its own positional arguments
 * come first, and everything after them belongs to the program. Commander
 * cannot express that — `passThroughOptions` would, but it requires positional
 * parsing on the root command, which stops every nested command from seeing its
 * parent's options (`agency label ingest --store x` fails outright).
 *
 * So the boundary is drawn before commander runs, by inserting `--`. Commander
 * removes the separator itself, so the program never sees it.
 *
 * Two commands need this and differ only in their policy, which is why they
 * share one walk rather than one each:
 *
 *   run    one owned positional (the filename); warns on a collision
 *   agent  no owned positionals; forwards its own flags without comment
 */
export type Arity = "none" | "required" | "optional";

export type CliOption = { short?: string; long?: string; arity: Arity };

export type Boundary = {
  /** Subcommand this applies to. */
  command: string;
  /** Agency's own positional arguments, which sit before the program's. */
  ownedPositionals: number;
  /** Options agency parses before the boundary. */
  options: CliOption[];
  /** Whether to warn when one of `options` turns up after the boundary. */
  warnOnCollision: boolean;
};

export type SplitCommandLine = {
  /** argv with the separator inserted, ready for commander. */
  argv: string[];
  /** An agency flag that went to the program because of where it was written.
   *  Position still decides — this only says so out loud. */
  warning?: string;
};

export function splitCommandLine(
  argv: string[],
  rootOptions: CliOption[],
  boundaries: Boundary[],
): SplitCommandLine {
  const subcommand = findSubcommandIndex(argv, rootOptions);
  if (subcommand === -1) return { argv };
  const boundary = boundaries.find((b) => b.command === argv[subcommand]);
  if (boundary === undefined) return { argv };

  // Agency's flags come first, then its own positionals. Anything after that
  // is the program's, flags included — which is what the position rule means.
  let i = subcommand + 1;
  while (isFlag(argv[i])) {
    // The user drew the line themselves.
    if (argv[i] === "--") return { argv };
    const consumed = ownedFlagTokens(argv[i], argv[i + 1], boundary.options);
    // A flag agency does not own is already the program's.
    if (consumed === undefined) break;
    i += consumed;
  }
  if (argv[i] === "--") return { argv };

  let input: string | undefined;
  for (let n = 0; n < boundary.ownedPositionals; n += 1) {
    // Agency's own positional is missing. Commander reports that better.
    if (i >= argv.length || isFlag(argv[i])) return { argv };
    input = argv[i];
    i += 1;
  }

  const rest = argv.slice(i);
  if (rest.length === 0 || rest[0] === "--") return { argv };

  const claimed = boundary.warnOnCollision
    ? rest.flatMap((token) => flagNamesIn(token, boundary.options)).find(
        (name) => findOption(name, boundary.options) !== undefined,
      )
    : undefined;

  return {
    argv: [...argv.slice(0, i), "--", ...rest],
    warning:
      claimed === undefined
        ? undefined
        : misplacedFlagWarning(claimed, input ?? "your-program.agency"),
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
 * Walks past `node`, the script path, and agency's own top-level flags to find
 * the subcommand. Returns -1 if there is none.
 */
export function findSubcommandIndex(
  argv: string[],
  rootOptions: CliOption[],
): number {
  // argv[0] = node, argv[1] = script path. The search starts at 2.
  let i = 2;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--") return -1;
    if (!isFlag(token)) return i;
    i += tokensConsumedBy(token, argv[i + 1], rootOptions);
  }
  return -1;
}

function isFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith("-") && token !== "-";
}

function findOption(
  name: string,
  options: CliOption[],
): CliOption | undefined {
  return options.find((o) => o.short === name || o.long === name);
}

/**
 * The agency options a token names. Commander accepts four spellings and a
 * check that understands only the plainest one stays quiet for the rest:
 *
 *   --policy strict   --policy=strict   -c file.json   -cfile.json   -iv
 */
export function flagNamesIn(token: string, options: CliOption[]): string[] {
  if (!isFlag(token)) return [];
  if (token.startsWith("--")) {
    const equals = token.indexOf("=");
    return [equals === -1 ? token : token.slice(0, equals)];
  }
  return parseShortToken(token, options).names;
}

/**
 * Reads a short token left to right, the way commander does.
 *
 * The first letter decides whether the token is agency's at all: `-print` is a
 * program's flag, not a bundle containing agency's `-i`, because `-p` is not an
 * agency flag. Reading every letter instead would warn about it.
 */
function parseShortToken(
  token: string,
  options: CliOption[],
): { names: string[]; trailing?: CliOption } {
  const letters = [...token.slice(1)];
  const names: string[] = [];
  for (const [index, letter] of letters.entries()) {
    const option = findOption(`-${letter}`, options);
    // Unknown first letter: the whole token belongs to the program. Unknown
    // later: it is the attached value of the option before it.
    if (option === undefined) {
      return { names: index === 0 ? [] : names };
    }
    names.push(`-${letter}`);
    // A value-taking option ends the bundle. Its value is the rest of the
    // token, or the next word when it is the last letter.
    if (option.arity !== "none") {
      return index === letters.length - 1
        ? { names, trailing: option }
        : { names };
    }
  }
  return { names };
}

/**
 * How many tokens an agency flag covers, or undefined if it is not agency's.
 *
 * The next token is needed because commander treats the two value kinds
 * differently. A required value takes whatever follows, even another flag:
 * `--policy --verbose` gives policy="--verbose". An optional value steps over
 * something that looks like a flag — `--trace --verbose` leaves trace bare —
 * but still takes `-5`, because a digit after the dash reads as a negative
 * number rather than a flag.
 */
function ownedFlagTokens(
  token: string,
  next: string | undefined,
  options: CliOption[],
): number | undefined {
  if (token.startsWith("--")) {
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const arity = findOption(name, options)?.arity;
    if (arity === undefined) return undefined;
    if (equals !== -1) return 1;
    return tokensForValue(arity, next);
  }
  const short = parseShortToken(token, options);
  if (short.names.length === 0) return undefined;
  if (short.trailing === undefined) return 1;
  return tokensForValue(short.trailing.arity, next);
}

function tokensForValue(arity: Arity, next: string | undefined): number {
  if (arity === "none") return 1;
  if (arity === "required") return 2;
  return next === undefined || looksLikeOption(next) ? 1 : 2;
}

/** Commander's own test for "this token is a flag, not a value". */
function looksLikeOption(token: string): boolean {
  return (
    token.length > 1 &&
    token[0] === "-" &&
    (token[1] === "-" || Number.isNaN(Number.parseFloat(token[1])))
  );
}

/** Root-flag walking, where an unknown flag simply covers itself. */
function tokensConsumedBy(
  token: string,
  next: string | undefined,
  options: CliOption[],
): number {
  return ownedFlagTokens(token, next, options) ?? 1;
}
