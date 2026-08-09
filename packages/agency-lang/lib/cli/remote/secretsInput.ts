// Pure input handling for the remote secrets commands — a sibling of args.ts.
// No terminal, no `prompts`, no process globals: every environmental input
// (TTY-ness, stdin, the hidden prompt, the env) arrives injected, so the
// precedence rules and parsing are testable without a terminal. The concrete
// adapters live in confirmation.ts.


export type SecretValueSources = {
  /** --from-env VAR: the NAME of a local environment variable to copy. */
  fromEnv?: string;
  stdinIsTty: boolean;
  readStdin: () => Promise<string>;
  /** Hidden prompt; resolves undefined when the user cancels (ctrl-C / EOF). */
  promptHidden: (name: string) => Promise<string | undefined>;
  env: NodeJS.ProcessEnv;
};

export type SecretValueResult =
  | { kind: "value"; value: string }
  | { kind: "canceled" }
  | { kind: "error"; message: string };

/** Where a secret's value comes from, in precedence order: --from-env wins;
 *  else piped stdin; else the hidden TTY prompt. Never argv. */
export async function resolveSecretValue(
  name: string,
  sources: SecretValueSources,
): Promise<SecretValueResult> {
  if (sources.fromEnv !== undefined) {
    const value = sources.env[sources.fromEnv];
    if (value === undefined || value === "") {
      return {
        kind: "error",
        message: `$${sources.fromEnv} is not set (or is empty) — --from-env needs a non-empty variable.`,
      };
    }
    return { kind: "value", value };
  }
  if (!sources.stdinIsTty) {
    const value = stripOneTrailingNewline(await sources.readStdin());
    if (value === "") {
      return {
        kind: "error",
        message: "No value on stdin — pipe a non-empty value, or run interactively for a hidden prompt.",
      };
    }
    return { kind: "value", value };
  }
  const entered = await sources.promptHidden(name);
  if (entered === undefined) {
    return { kind: "canceled" };
  }
  if (entered === "") {
    return { kind: "error", message: "Secret value must not be empty." };
  }
  return { kind: "value", value: entered };
}

/** One terminal "\r\n" or "\n" removed — exactly one, so a value meant to keep
 *  a final newline supplies two (printf 'value\n\n'). Interior newlines are
 *  untouched. */
export function stripOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  if (text.endsWith("\n")) {
    return text.slice(0, -1);
  }
  return text;
}

export type ParsedEnvSource = {
  /** First-insertion key order; on a duplicate key the LAST assignment's value
   *  wins (in the original position). No duplicate reporting — a `B=` line
   *  inside a multiline quoted value is NOT an assignment, and
   *  last-value-wins is the behavior that matters. */
  entries: { name: string; value: string }[];
};

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A small, OWNED dotenv parser. Deliberately not node:util's parseEnv: its
 *  quoted-value handling differs across Node releases inside the supported
 *  engine range (22.13.0 mis-splits `B="x=y"` into a bogus extra entry), and
 *  secret values must parse identically on every supported version. Semantics
 *  (pinned by tests): `NAME=value` lines; optional `export ` prefix; `#`
 *  comments and blank lines skipped; single- or double-quoted values may span
 *  lines and keep `=`/`#` literally; quoted content is LITERAL (no escape
 *  expansion); unquoted values run to end of line, trimmed. Never touches
 *  process.env. */
export function parseEnvSource(text: string): ParsedEnvSource {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const values = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }
    const equals = line.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const name = line.slice(0, equals).trim();
    if (!NAME_PATTERN.test(name)) {
      continue;
    }
    const rest = line.slice(equals + 1).trim();
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0];
      let accumulated = rest.slice(1);
      let closing = accumulated.indexOf(quote);
      while (closing === -1 && index + 1 < lines.length) {
        index++;
        accumulated += `\n${lines[index]}`;
        closing = accumulated.indexOf(quote);
      }
      values.set(name, closing === -1 ? accumulated : accumulated.slice(0, closing));
    } else {
      values.set(name, rest);
    }
  }
  return { entries: [...values.entries()].map(([name, value]) => ({ name, value })) };
}

/** Single-line, terminal-safe rendering for untrusted display text (names,
 *  server messages): a string containing terminal-control characters is
 *  JSON-quoted so it cannot manipulate the terminal; plain strings pass
 *  through unchanged. "Control" covers C0, DEL, and the C1 range (U+009B is a
 *  bare CSI) plus the U+2028/U+2029 line separators — and because
 *  JSON.stringify escapes only C0, the quoted form is post-processed so every
 *  such character ends up as a \\uXXXX escape. Always applied AFTER
 *  redaction. */
export function terminalSafe(text: string): string {
  if (![...text].some((character) => isTerminalUnsafe(character.codePointAt(0) ?? 0))) {
    return text;
  }
  let escaped = "";
  for (const character of JSON.stringify(text)) {
    const code = character.codePointAt(0) ?? 0;
    escaped += isTerminalUnsafe(code)
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : character;
  }
  return escaped;
}

function isTerminalUnsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}
