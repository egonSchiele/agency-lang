// Pure input handling for the remote secrets commands — a sibling of args.ts.
// No terminal, no `prompts`, no process globals: every environmental input
// (TTY-ness, stdin, the hidden prompt, the env) arrives injected, so the
// precedence rules and parsing are testable without a terminal. The concrete
// adapters live in confirmation.ts.

import { parseEnv } from "node:util";

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
  /** Object.entries(parseEnv(text)): first-insertion key order, and on a
   *  duplicate key the LAST assignment's value. No duplicate reporting —
   *  detecting duplicates would need a second, quote-aware dotenv parser (a
   *  `B=` line inside a multiline quoted value is NOT an assignment), and
   *  last-value-wins is the behavior that matters. */
  entries: { name: string; value: string }[];
};

/** Pure wrapper over node:util's parseEnv. Never touches process.env. */
export function parseEnvSource(text: string): ParsedEnvSource {
  const parsed = parseEnv(text) as Record<string, string>;
  return {
    entries: Object.entries(parsed).map(([name, value]) => ({ name, value })),
  };
}

/** Single-line, terminal-safe rendering for untrusted display text (names,
 *  server messages): a string containing control characters — including ANSI
 *  escapes — is JSON-quoted so it cannot manipulate the terminal; plain
 *  strings pass through unchanged. Always applied AFTER redaction. */
export function terminalSafe(text: string): string {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return JSON.stringify(text);
    }
  }
  return text;
}
