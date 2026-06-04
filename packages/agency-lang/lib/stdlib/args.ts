import process from "process";
import * as path from "path";
import { parseArgs as nodeParseArgs } from "node:util";

// ---------------------------------------------------------------------------
// TS bridge for `std::args` — CLI flag parser.
//
// Thin wrapper over Node's built-in `node:util.parseArgs` (stable
// since Node 18.3). On top of Node's tokenization we add:
//   - strict number coercion
//   - required-flag checking with explicit defaults
//   - auto-generated --help / --version
//   - mutually-exclusive / required-together flag groups
//   - unified error formatting → stderr → exit 2
//
// The orchestrator (_parseArgs / _parseArgsWith at the bottom) is the
// only thing in this file that touches process.argv, process.exit,
// process.stdout, or process.stderr. Every other function is a pure
// data transform that returns either data or a tagged ParseResult.
//
// Design doc: docs/superpowers/specs/2026-06-04-cli-args-design.md
// Impl plan:  docs/superpowers/plans/2026-06-04-cli-args-plan.md
// ---------------------------------------------------------------------------

// =============================================================================
// Public types — mirrored in stdlib/args.agency
// =============================================================================

export type FlagType = "string" | "number" | "boolean";

export type FlagSpec = {
  type: FlagType;
  short?: string;
  default?: string | number | boolean;
  required?: boolean;
  description?: string;
  choices?: string[];
  hidden?: boolean;
};

export type FlagGroups = {
  exclusive?: string[][];
  requiredTogether?: string[][];
};

export type ArgsSchema = {
  programName?: string;
  description?: string;
  version?: string;
  epilog?: string;
  flags: Record<string, FlagSpec>;
  groups?: FlagGroups;
};

export type ParsedArgs = {
  flags: Record<string, string | number | boolean>;
  positionals: string[];
};

// =============================================================================
// Internal types
// =============================================================================

// Every downstream step works on the normalized form so it never has
// to re-check "did the user set this optional field". Absent optionals
// are represented as `null` / `false` / `""` / `[]` — never `undefined`.
export type NormalizedFlag = {
  name: string;
  type: FlagType;
  short: string | null;
  default: string | number | boolean | null;
  required: boolean;
  description: string;
  choices: string[] | null;
  hidden: boolean;
};

export type NormalizedSchema = {
  programName: string;
  description: string | null;
  version: string | null;
  epilog: string | null;
  // Array preserves declaration order for --help. flagsByName / flagsByShort
  // are the lookup indexes.
  flags: NormalizedFlag[];
  flagsByName: Record<string, NormalizedFlag>;
  flagsByShort: Record<string, NormalizedFlag>;
  groups: {
    exclusive: string[][];
    requiredTogether: string[][];
  };
  autoHelp: boolean;
  autoVersion: boolean;
};

// Discriminated union — one variant per error case in the spec catalog.
// Adding a new error case = add a variant + add a row to ERROR_FORMATTERS
// at the bottom. TypeScript will fail the build if the formatter table
// is incomplete.
export type ParseError =
  | { kind: "unknownLong"; flag: string }
  | { kind: "unknownShort"; flag: string }
  | { kind: "missingValue"; flag: string }
  | { kind: "missingRequired"; flag: string }
  | { kind: "invalidNumber"; flag: string; raw: string }
  | { kind: "invalidChoice"; flag: string; raw: string; choices: string[] }
  | { kind: "booleanTakesNoValue"; flag: string }
  | { kind: "greedyValue"; flag: string; raw: string }
  | { kind: "shortEqualsSyntax"; raw: string; suggestion: string }
  | { kind: "duplicateFlag"; flag: string }
  | { kind: "mutuallyExclusive"; a: string; b: string }
  | { kind: "requiredTogether"; missing: string; trigger: string };

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ParseError };

// =============================================================================
// validateSchema — fail-fast schema bug detection
// =============================================================================
//
// Each rule is a row in the SCHEMA_RULES table. Adding a rule = adding
// one row. No nested conditionals, no order dependency between rules,
// no shared state.

const FLAG_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

type SchemaRule = {
  name: string;
  check: (schema: ArgsSchema) => string | null;
};

const SCHEMA_RULES: SchemaRule[] = [
  {
    name: "flag name is valid identifier",
    check: (s) => {
      const bad = Object.keys(s.flags).find(
        (n) => !FLAG_NAME_PATTERN.test(n),
      );
      return bad
        ? `invalid flag name "${bad}" (must match /^[a-z0-9][a-z0-9-]*$/)`
        : null;
    },
  },
  {
    name: "every flag has a valid type",
    check: (s) => {
      const bad = Object.entries(s.flags).find(
        ([, spec]) =>
          spec.type !== "string" &&
          spec.type !== "number" &&
          spec.type !== "boolean",
      );
      return bad
        ? `flag --${bad[0]} has invalid type "${String(bad[1].type)}" (must be "string", "number", or "boolean")`
        : null;
    },
  },
  {
    name: "short alias is single character",
    check: (s) => {
      const bad = Object.entries(s.flags).find(
        ([, spec]) => spec.short !== undefined && spec.short.length !== 1,
      );
      return bad
        ? `flag --${bad[0]} short alias "${bad[1].short}" must be exactly one character`
        : null;
    },
  },
  { name: "no duplicate short aliases", check: (s) => duplicateShort(s) },
  { name: "default type matches flag type", check: (s) => mismatchedDefault(s) },
  {
    name: "required and default are not both set",
    check: (s) => {
      const bad = Object.entries(s.flags).find(
        ([, spec]) => spec.required === true && spec.default !== undefined,
      );
      return bad
        ? `flag --${bad[0]} declares both required and default; pick one`
        : null;
    },
  },
  {
    name: "choices only on string flags",
    check: (s) => {
      const bad = Object.entries(s.flags).find(
        ([, spec]) => spec.choices !== undefined && spec.type !== "string",
      );
      return bad
        ? `flag --${bad[0]} has choices but is not a string flag`
        : null;
    },
  },
  {
    // v1 does not support negatable booleans (--no-X), so a boolean
    // declared default: true can never be set to false from the CLI.
    // Reject as a schema bug rather than silently shipping a dead flag.
    name: "boolean flags must not default to true (v1, no --no-X)",
    check: (s) => {
      const bad = Object.entries(s.flags).find(
        ([, spec]) => spec.type === "boolean" && spec.default === true,
      );
      return bad
        ? `flag --${bad[0]} is a boolean with default: true; v1 does not support negatable booleans (--no-${bad[0]}), so this flag could never be set to false. Drop the default, or wait for negatableBooleans.`
        : null;
    },
  },
  {
    // When auto-help is active, NOTHING else can claim -h — even
    // another boolean flag would silently collide with the injected
    // --help (duplicate shortAlias in flagsByShort / buildNodeOptions).
    // The user must declare their own `help` flag to override auto-help.
    name: "no -h short collision when auto-help is active",
    check: (s) => {
      const userDeclaresHelp = "help" in s.flags;
      if (userDeclaresHelp) return null;
      const bad = Object.entries(s.flags).find(
        ([, spec]) => spec.short === "h",
      );
      return bad
        ? `flag --${bad[0]} uses short -h, which collides with the auto-injected --help. Declare your own "help" flag in the schema to override auto-help.`
        : null;
    },
  },
  {
    // Same rule as -h: when auto-version is active, no other flag can
    // claim -V. User must declare their own `version` flag to override.
    name: "no -V short collision when auto-version is active",
    check: (s) => {
      if (s.version === undefined) return null;
      const userDeclaresVersion = "version" in s.flags;
      if (userDeclaresVersion) return null;
      const bad = Object.entries(s.flags).find(
        ([, spec]) => spec.short === "V",
      );
      return bad
        ? `flag --${bad[0]} uses short -V, which collides with the auto-injected --version. Declare your own "version" flag in the schema to override auto-version.`
        : null;
    },
  },
  { name: "group references known flags", check: (s) => unknownGroupRef(s) },
];

export function validateSchema(schema: ArgsSchema): void {
  for (const rule of SCHEMA_RULES) {
    const failure = rule.check(schema);
    if (failure !== null) {
      throw new Error(`std::args: schema error: ${failure}`);
    }
  }
}

function duplicateShort(schema: ArgsSchema): string | null {
  const seen: Record<string, string> = {};
  for (const [name, spec] of Object.entries(schema.flags)) {
    if (spec.short === undefined) continue;
    const prev = seen[spec.short];
    if (prev !== undefined) {
      return `flags --${prev} and --${name} both declare short alias -${spec.short}`;
    }
    seen[spec.short] = name;
  }
  return null;
}

function mismatchedDefault(schema: ArgsSchema): string | null {
  for (const [name, spec] of Object.entries(schema.flags)) {
    if (spec.default === undefined) continue;
    const actual = typeof spec.default;
    if (actual !== spec.type) {
      return `flag --${name} has type "${spec.type}" but default ${JSON.stringify(spec.default)} is a ${actual}`;
    }
  }
  return null;
}

function unknownGroupRef(schema: ArgsSchema): string | null {
  const known = new Set(Object.keys(schema.flags));
  const allGroups: { kind: string; group: string[] }[] = [
    ...(schema.groups?.exclusive ?? []).map((g) => ({ kind: "exclusive", group: g })),
    ...(schema.groups?.requiredTogether ?? []).map((g) => ({
      kind: "requiredTogether",
      group: g,
    })),
  ];
  for (const { kind, group } of allGroups) {
    const missing = group.find((name) => !known.has(name));
    if (missing !== undefined) {
      return `groups.${kind} references unknown flag --${missing}`;
    }
  }
  return null;
}

// =============================================================================
// normalizeSchema — flatten the user-facing schema into the internal form
// =============================================================================
//
// Every absent optional becomes `null` / `false` / `""` / `[]` so the
// rest of the pipeline doesn't have to keep asking "is this set?".
// Boolean flags without an explicit default get `default: false` here,
// per the spec's "Booleans without a default behave as false" rule —
// validateSchema has already rejected default: true on booleans, so
// the only possible boolean defaults at this point are false (explicit
// or filled-in).

export function normalizeSchema(schema: ArgsSchema): NormalizedSchema {
  const userDeclaresHelp = "help" in schema.flags;
  const userDeclaresVersion = "version" in schema.flags;
  const autoHelp = !userDeclaresHelp;
  const autoVersion = !userDeclaresVersion && schema.version !== undefined;

  const userFlags: NormalizedFlag[] = Object.entries(schema.flags).map(
    ([name, spec]) => normalizeFlag(name, spec),
  );

  const helpFlag: NormalizedFlag | null = autoHelp
    ? normalizeFlag("help", {
        type: "boolean",
        short: "h",
        description: "Show this help and exit",
      })
    : null;
  const versionFlag: NormalizedFlag | null = autoVersion
    ? normalizeFlag("version", {
        type: "boolean",
        short: "V",
        description: "Show version and exit",
      })
    : null;

  const flags = [...userFlags, helpFlag, versionFlag].filter(
    (f): f is NormalizedFlag => f !== null,
  );

  return {
    programName: schema.programName ?? deriveProgramName(),
    description: schema.description ?? null,
    version: schema.version ?? null,
    epilog: schema.epilog ?? null,
    flags,
    flagsByName: indexBy(flags, (f) => f.name),
    flagsByShort: indexBy(
      flags.filter((f) => f.short !== null),
      (f) => f.short as string,
    ),
    groups: {
      exclusive: schema.groups?.exclusive ?? [],
      requiredTogether: schema.groups?.requiredTogether ?? [],
    },
    autoHelp,
    autoVersion,
  };
}

function normalizeFlag(name: string, spec: FlagSpec): NormalizedFlag {
  const defaultValue =
    spec.default !== undefined
      ? spec.default
      : spec.type === "boolean"
        ? false
        : null;
  return {
    name,
    type: spec.type,
    short: spec.short ?? null,
    default: defaultValue,
    required: spec.required ?? false,
    description: spec.description ?? "",
    choices: spec.choices ?? null,
    hidden: spec.hidden ?? false,
  };
}

function deriveProgramName(): string {
  return path.basename(process.argv[1] ?? "program");
}

function indexBy<T>(items: T[], key: (item: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) {
    out[key(item)] = item;
  }
  return out;
}

// =============================================================================
// preScanArgv — reject -n=value and --x --y greedy values
// =============================================================================

type ArgvRule = (
  token: string,
  next: string | undefined,
  schema: NormalizedSchema,
) => ParseError | null;

const ARGV_RULES: ArgvRule[] = [
  // -n=value: short flag with attached "=" (Node would produce "=value")
  (token) => {
    const match = /^-([a-zA-Z])=(.*)$/.exec(token);
    if (!match) return null;
    const [, letter, value] = match;
    return {
      kind: "shortEqualsSyntax",
      raw: token,
      suggestion: `-${letter} ${value} or -${letter}${value}`,
    };
  },
  // --name --foo: greedy value capture for string/number flags
  (token, next, schema) => {
    if (!token.startsWith("--") || token.includes("=") || token === "--") {
      return null;
    }
    const name = token.slice(2);
    const flag = schema.flagsByName[name];
    if (flag === undefined || flag.type === "boolean") return null;
    if (next === undefined || !next.startsWith("--")) return null;
    return { kind: "greedyValue", flag: name, raw: next };
  },
];

export function preScanArgv(
  argv: string[],
  schema: NormalizedSchema,
): ParseResult<void> {
  // Tracks single-value (string/number) flags we've already seen, so
  // a second occurrence trips the duplicateFlag rule below. Booleans
  // are excluded — repeating `--verbose --verbose` is harmless and
  // node:util.parseArgs accepts it without warning.
  const seen: Record<string, boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") break; // honor end-of-options

    for (const rule of ARGV_RULES) {
      const err = rule(token, argv[i + 1], schema);
      if (err !== null) return { ok: false, error: err };
    }

    const flagName = flagNameOf(token, schema);
    if (flagName !== null) {
      const flag = schema.flagsByName[flagName];
      if (flag !== undefined && flag.type !== "boolean") {
        if (seen[flagName] === true) {
          return {
            ok: false,
            error: { kind: "duplicateFlag", flag: flagName },
          };
        }
        seen[flagName] = true;
      }
    }
  }
  return { ok: true, value: undefined };
}

// Extract the long flag name a token is referring to, if any.
// Handles `--name`, `--name=value`, `-n`, and `-nvalue` (attached
// short value). Returns null for non-flag tokens (positionals,
// `-`, etc.). Resolves short aliases to their declared long names.
function flagNameOf(token: string, schema: NormalizedSchema): string | null {
  if (token.startsWith("--")) {
    if (token === "--") return null;
    const body = token.slice(2);
    const eq = body.indexOf("=");
    return eq === -1 ? body : body.slice(0, eq);
  }
  if (token.startsWith("-") && token.length >= 2 && token !== "-") {
    const shortLetter = token[1];
    const flag = schema.flagsByShort[shortLetter];
    return flag !== undefined ? flag.name : null;
  }
  return null;
}

// =============================================================================
// callNodeParse — thin wrapper over node:util.parseArgs
// =============================================================================
//
// Maps our schema to Node's options object, calls parseArgs, and
// translates Node's error codes into our ParseError union. Numbers
// are passed through as Node `string` type and coerced later in
// coerceValues — Node only knows "string" and "boolean".

type NodeParseOutput = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

// Shape of the errors `node:util.parseArgs` throws. They carry an
// ErrnoException-style `code` we dispatch on, and arbitrary string
// formatting in `message` we pattern-match for the offending flag.
type NodeParseError = Error & { code?: string };

const NODE_ERROR_TRANSLATIONS: Record<string, (e: NodeParseError) => ParseError> = {
  ERR_PARSE_ARGS_UNKNOWN_OPTION: translateUnknown,
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: translateInvalidValue,
};

export function callNodeParse(
  argv: string[],
  schema: NormalizedSchema,
): ParseResult<NodeParseOutput> {
  const options = buildNodeOptions(schema);
  try {
    const out = nodeParseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: true,
    });
    return {
      ok: true,
      value: {
        flags: out.values as Record<string, string | boolean>,
        positionals: [...out.positionals],
      },
    };
  } catch (e) {
    const err = e as NodeParseError;
    const translate = err.code !== undefined
      ? NODE_ERROR_TRANSLATIONS[err.code]
      : undefined;
    if (translate === undefined) throw e; // unknown Node error — surface loudly
    return { ok: false, error: translate(err) };
  }
}

function buildNodeOptions(
  schema: NormalizedSchema,
): Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> {
  const out: Record<
    string,
    { type: "string" | "boolean"; short?: string; multiple?: boolean }
  > = {};
  for (const f of schema.flags) {
    const nodeType: "string" | "boolean" =
      f.type === "boolean" ? "boolean" : "string";
    const entry: { type: "string" | "boolean"; short?: string } = {
      type: nodeType,
    };
    if (f.short !== null) entry.short = f.short;
    out[f.name] = entry;
  }
  return out;
}

function translateUnknown(err: NodeParseError): ParseError {
  // Node messages look like: Unknown option '--foo'  OR  Unknown option '-x'
  const m = /Unknown option '(-{1,2})([^']+)'/.exec(err.message);
  if (m === null) {
    // Defensive: fall back to a generic unknown-long with the whole message.
    return { kind: "unknownLong", flag: err.message };
  }
  const [, dashes, name] = m;
  if (dashes === "-") {
    return { kind: "unknownShort", flag: name };
  }
  return { kind: "unknownLong", flag: name };
}

function translateInvalidValue(err: NodeParseError): ParseError {
  // ERR_PARSE_ARGS_INVALID_OPTION_VALUE is emitted by Node for two
  // distinct situations; the message format always includes the long
  // flag name as `--name` somewhere inside the quoted Option clause,
  // even when a short alias is also reported (e.g. `-n, --name`).
  //
  //   "Option '--name <value>' argument missing"
  //   "Option '-n, --name <value>' argument missing"
  //     → string/number flag with no value (kind: "missingValue")
  //
  //   "Option '--verbose' does not take an argument"
  //   "Option '-v, --verbose' does not take an argument"
  //     → boolean flag given a value (kind: "booleanTakesNoValue")
  const longName = /--([a-zA-Z0-9][a-zA-Z0-9-]*)/.exec(err.message)?.[1];
  if (longName !== undefined) {
    if (err.message.endsWith("argument missing")) {
      return { kind: "missingValue", flag: longName };
    }
    if (err.message.includes("does not take an argument")) {
      return { kind: "booleanTakesNoValue", flag: longName };
    }
  }
  // Defensive: surface the whole message as the flag — better than
  // swallowing. The orchestrator's formatError will still print it.
  return { kind: "missingValue", flag: err.message };
}

// =============================================================================
// coerceValues — strict number parsing + choices validation
// =============================================================================

const REJECTED_NUMBER_PATTERNS: { test: (raw: string) => boolean; why: string }[] = [
  { test: (s) => s === "", why: "empty string" },
  { test: (s) => s !== s.trim(), why: "leading/trailing whitespace" },
  { test: (s) => /^[+-]?0[xob]/i.test(s), why: "non-decimal literal" },
  {
    test: (s) => /^[+-]?Infinity$|^NaN$/.test(s),
    why: "non-finite",
  },
];

export function parseStrictNumber(raw: string): number | null {
  if (REJECTED_NUMBER_PATTERNS.some((p) => p.test(raw))) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function coerceValues(
  parsed: Record<string, string | boolean>,
  schema: NormalizedSchema,
): ParseResult<Record<string, string | number | boolean>> {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, raw] of Object.entries(parsed)) {
    const flag = schema.flagsByName[name];
    // Node should never give us a flag we didn't declare since strict: true.
    // If it does (auto-help passes through here), just pass the value.
    if (flag === undefined) {
      out[name] = raw;
      continue;
    }
    const coerced = coerceOne(flag, raw);
    if (!coerced.ok) return coerced;
    out[name] = coerced.value;
  }
  return { ok: true, value: out };
}

function coerceOne(
  flag: NormalizedFlag,
  raw: string | boolean,
): ParseResult<string | number | boolean> {
  if (flag.type === "boolean") {
    return { ok: true, value: raw };
  }
  if (flag.type === "number") {
    const n = parseStrictNumber(raw as string);
    if (n === null) {
      return {
        ok: false,
        error: { kind: "invalidNumber", flag: flag.name, raw: raw as string },
      };
    }
    return { ok: true, value: n };
  }
  // string: validate choices if present
  const value = raw as string;
  if (flag.choices !== null && !flag.choices.includes(value)) {
    return {
      ok: false,
      error: {
        kind: "invalidChoice",
        flag: flag.name,
        raw: value,
        choices: flag.choices,
      },
    };
  }
  return { ok: true, value };
}

// =============================================================================
// applyDefaults — fill in missing flags from their declared defaults,
// then check that every required flag without a default was provided
// =============================================================================

export function applyDefaults(
  parsed: Record<string, string | number | boolean>,
  schema: NormalizedSchema,
): ParseResult<Record<string, string | number | boolean>> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of schema.flags) {
    if (f.name in parsed) {
      out[f.name] = parsed[f.name];
    } else if (f.default !== null) {
      out[f.name] = f.default;
    }
  }
  const missing = schema.flags.find((f) => f.required && !(f.name in out));
  if (missing !== undefined) {
    return {
      ok: false,
      error: { kind: "missingRequired", flag: missing.name },
    };
  }
  return { ok: true, value: out };
}

// =============================================================================
// checkGroups — exclusive and requiredTogether
// =============================================================================
//
// Runs after applyDefaults, so a flag with a default counts as "set"
// for group purposes (per spec: "A flag listed in requiredTogether
// interacts cleanly with required/default: a flag with a default is
// considered 'set' for group purposes.").

export function checkGroups(
  parsed: Record<string, unknown>,
  schema: NormalizedSchema,
): ParseResult<void> {
  for (const group of schema.groups.exclusive) {
    const set = group.filter((name) => name in parsed);
    if (set.length >= 2) {
      return {
        ok: false,
        error: { kind: "mutuallyExclusive", a: set[0], b: set[1] },
      };
    }
  }
  for (const group of schema.groups.requiredTogether) {
    const set = group.filter((name) => name in parsed);
    if (set.length > 0 && set.length < group.length) {
      const missing = group.find((name) => !(name in parsed));
      if (missing !== undefined) {
        return {
          ok: false,
          error: { kind: "requiredTogether", missing, trigger: set[0] },
        };
      }
    }
  }
  return { ok: true, value: undefined };
}

// =============================================================================
// formatHelp — generate the --help text
// =============================================================================

// Layout constants. Pulled out so they're easy to find and adjust as
// a group. v1 emits no ANSI.
const HELP_MAX_LEFT_WIDTH = 30;
const HELP_MIN_DESC_WIDTH = 20;
const HELP_GUTTER = 2; // spaces between left column and description
const DEFAULT_TERMINAL_WIDTH = 80;

type OptionRow = {
  shortPart: string; // "-n, " or "    "
  longPart: string; // "--name <string>"
  description: string;
};

export function formatHelp(schema: NormalizedSchema): string {
  const rows = schema.flags
    .filter((f) => !f.hidden)
    .map(toRow);

  const longestLeft = Math.max(
    0,
    ...rows.map((r) => r.shortPart.length + r.longPart.length),
  );
  const leftWidth = Math.min(HELP_MAX_LEFT_WIDTH, longestLeft);
  const termWidth = process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
  const descWidth = Math.max(
    HELP_MIN_DESC_WIDTH,
    termWidth - leftWidth - HELP_GUTTER,
  );

  const optionsBlock =
    "Options:\n" +
    rows.map((r) => renderRow(r, leftWidth, descWidth)).join("\n");

  const sections: string[] = [
    `Usage: ${schema.programName} [options] [args...]`,
  ];
  if (schema.description !== null) sections.push(schema.description);
  sections.push(optionsBlock);
  if (schema.epilog !== null) sections.push(schema.epilog);

  return sections.join("\n\n") + "\n";
}

function toRow(f: NormalizedFlag): OptionRow {
  return {
    shortPart: f.short !== null ? `-${f.short}, ` : "    ",
    longPart: `--${f.name}${valuePlaceholder(f)}`,
    description: composeDescription(f),
  };
}

function valuePlaceholder(f: NormalizedFlag): string {
  if (f.type === "boolean") return "";
  if (f.choices !== null) return ` <${f.choices.join("|")}>`;
  return ` <${f.type}>`;
}

function composeDescription(f: NormalizedFlag): string {
  const parts: string[] = [];
  if (f.description.length > 0) parts.push(f.description);
  // Boolean defaults are always false (validateSchema rejects true) and
  // implied — don't clutter help with "(default: false)".
  if (f.type !== "boolean" && f.default !== null && !f.required) {
    parts.push(`(default: ${formatDefault(f.default)})`);
  }
  if (f.required && f.default === null) parts.push("(required)");
  return parts.join(" ");
}

function formatDefault(value: string | number | boolean): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function renderRow(row: OptionRow, leftWidth: number, descWidth: number): string {
  const left = row.shortPart + row.longPart;
  const padded = left.padEnd(leftWidth + HELP_GUTTER, " ");
  const lines = wrapText(row.description, descWidth);
  if (lines.length === 0) return "  " + padded.trimEnd();
  const indent = " ".repeat(2 + leftWidth + HELP_GUTTER);
  return (
    "  " +
    padded +
    lines[0] +
    lines.slice(1).map((l) => "\n" + indent + l).join("")
  );
}

function wrapText(text: string, width: number): string[] {
  if (text.length === 0) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (current.length === 0) {
      current = w;
      continue;
    }
    if (current.length + 1 + w.length > width) {
      lines.push(current);
      current = w;
    } else {
      current += " " + w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// =============================================================================
// formatError — every ParseError kind → one-line message
// =============================================================================
//
// One row per ParseError kind. The mapped-object type makes the
// formatter table exhaustive — drop a kind and TS won't compile.

const ERROR_FORMATTERS: {
  [K in ParseError["kind"]]: (e: Extract<ParseError, { kind: K }>) => string;
} = {
  unknownLong: (e) => `unknown flag --${e.flag}`,
  unknownShort: (e) => `unknown short flag -${e.flag}`,
  missingValue: (e) => `missing value for --${e.flag}`,
  missingRequired: (e) => `missing required flag --${e.flag}`,
  invalidNumber: (e) => `invalid number for --${e.flag}: "${e.raw}"`,
  invalidChoice: (e) =>
    `invalid value for --${e.flag}: "${e.raw}" (expected one of: ${e.choices.join(", ")})`,
  booleanTakesNoValue: (e) => `flag --${e.flag} does not take a value`,
  greedyValue: (e) =>
    `--${e.flag} expects a value; got ${e.raw} (use --${e.flag}=${e.raw} to force)`,
  shortEqualsSyntax: (e) =>
    `invalid short flag syntax in "${e.raw}": use ${e.suggestion}`,
  duplicateFlag: (e) => `flag --${e.flag} was provided more than once`,
  mutuallyExclusive: (e) => `--${e.a} and --${e.b} are mutually exclusive`,
  requiredTogether: (e) => `--${e.trigger} requires --${e.missing}`,
};

export function formatError(error: ParseError, schema: NormalizedSchema): string {
  // Cast through the lookup: TS can't narrow `error.kind` to the
  // formatter's parameter type without an explicit dispatch, but the
  // mapped-object type above guarantees the lookup is exhaustive.
  const fn = ERROR_FORMATTERS[error.kind] as (e: ParseError) => string;
  return `Error: ${fn(error)}\n\n${formatHelp(schema)}`;
}

// =============================================================================
// _parseArgs / _parseArgsWith — orchestrator
// =============================================================================
//
// The only functions in this file that touch process.argv,
// process.exit, process.stdout, or process.stderr. Each step is one
// const + one explicit early-return on failure. The --help / --version
// short-circuit sits between callNodeParse and coerceValues so that
// `mytool --help` always prints help, even when required flags are
// missing or other coerce errors would fire.

export function _parseArgs(schema: ArgsSchema): ParsedArgs {
  return _parseArgsWith(process.argv.slice(2), schema);
}

// Exported for tests; NOT re-exported from stdlib/args.agency.
export function _parseArgsWith(
  argv: string[],
  schema: ArgsSchema,
): ParsedArgs {
  validateSchema(schema); // throws on schema bugs
  const normalized = normalizeSchema(schema);

  // Stage 1: tokenize. Pre-scan rejects -n=v and --x --y greedy values.
  const preScan = preScanArgv(argv, normalized);
  if (!preScan.ok) return exitWithError(preScan.error, normalized);

  const parsed = callNodeParse(argv, normalized);
  if (!parsed.ok) return exitWithError(parsed.error, normalized);

  // Stage 2: short-circuit --help / --version BEFORE coerce/defaults/required.
  if (normalized.autoHelp && parsed.value.flags.help === true) {
    return exitWithHelp(normalized);
  }
  if (normalized.autoVersion && parsed.value.flags.version === true) {
    return exitWithVersion(normalized);
  }

  // Stage 3: coerce types, apply defaults, check required, check groups.
  const coerced = coerceValues(parsed.value.flags, normalized);
  if (!coerced.ok) return exitWithError(coerced.error, normalized);

  const withDefaults = applyDefaults(coerced.value, normalized);
  if (!withDefaults.ok) return exitWithError(withDefaults.error, normalized);

  const grouped = checkGroups(withDefaults.value, normalized);
  if (!grouped.ok) return exitWithError(grouped.error, normalized);

  return buildResult(
    withDefaults.value,
    parsed.value.positionals,
    normalized,
  );
}

function buildResult(
  flags: Record<string, string | number | boolean>,
  positionals: string[],
  schema: NormalizedSchema,
): ParsedArgs {
  // Strip auto-injected help/version flags from the user-visible result.
  const visible = Object.create(null) as Record<
    string,
    string | number | boolean
  >;
  for (const [name, value] of Object.entries(flags)) {
    if (schema.autoHelp && name === "help") continue;
    if (schema.autoVersion && name === "version") continue;
    visible[name] = value;
  }
  return { flags: visible, positionals };
}

function exitWithError(error: ParseError, schema: NormalizedSchema): never {
  process.stderr.write(formatError(error, schema));
  process.exit(2);
}

function exitWithHelp(schema: NormalizedSchema): never {
  process.stdout.write(formatHelp(schema));
  process.exit(0);
}

function exitWithVersion(schema: NormalizedSchema): never {
  // schema.version is non-null whenever autoVersion is true; the cast
  // is safe given the dispatch in _parseArgsWith.
  process.stdout.write((schema.version ?? "") + "\n");
  process.exit(0);
}
