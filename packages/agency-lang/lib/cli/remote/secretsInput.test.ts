import { describe, it, expect, vi } from "vitest";
import {
  resolveSecretValue,
  parseEnvSource,
  stripOneTrailingNewline,
  terminalSafe,
} from "./secretsInput.js";
import type { SecretValueSources } from "./secretsInput.js";

function sources(overrides: Partial<SecretValueSources>): SecretValueSources {
  return {
    stdinIsTty: true,
    readStdin: vi.fn().mockResolvedValue(""),
    promptHidden: vi.fn().mockResolvedValue("prompted"),
    env: {},
    ...overrides,
  };
}

describe("resolveSecretValue", () => {
  it("--from-env wins over everything and copies the variable", async () => {
    const readStdin = vi.fn();
    const promptHidden = vi.fn();
    const result = await resolveSecretValue(
      "N",
      sources({
        fromEnv: "MY_VAR",
        env: { MY_VAR: "from-env-value" },
        stdinIsTty: false,
        readStdin,
        promptHidden,
      }),
    );
    expect(result).toEqual({ kind: "value", value: "from-env-value" });
    expect(readStdin).not.toHaveBeenCalled();
    expect(promptHidden).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", {}],
    ["empty", { MY_VAR: "" }],
  ])("--from-env with an %s variable is an error and makes no other reads", async (_label, env) => {
    const result = await resolveSecretValue("N", sources({ fromEnv: "MY_VAR", env }));
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("$MY_VAR");
    }
  });

  it("piped stdin strips exactly one \\n", async () => {
    const result = await resolveSecretValue(
      "N",
      sources({
        stdinIsTty: false,
        readStdin: vi.fn().mockResolvedValue("piped-value\n"),
      }),
    );
    expect(result).toEqual({ kind: "value", value: "piped-value" });
  });

  it("piped stdin strips exactly one \\r\\n", async () => {
    const result = await resolveSecretValue(
      "N",
      sources({
        stdinIsTty: false,
        readStdin: vi.fn().mockResolvedValue("crlf-value\r\n"),
      }),
    );
    expect(result).toEqual({ kind: "value", value: "crlf-value" });
  });

  it("two trailing newlines keep one", async () => {
    const result = await resolveSecretValue(
      "N",
      sources({
        stdinIsTty: false,
        readStdin: vi.fn().mockResolvedValue("keeps-one\n\n"),
      }),
    );
    expect(result).toEqual({ kind: "value", value: "keeps-one\n" });
  });

  it("empty piped stdin is an error", async () => {
    const result = await resolveSecretValue(
      "N",
      sources({
        stdinIsTty: false,
        readStdin: vi.fn().mockResolvedValue("\n"),
      }),
    );
    expect(result.kind).toBe("error");
  });

  it("TTY prompt returns the entered value", async () => {
    const result = await resolveSecretValue(
      "N",
      sources({
        promptHidden: vi.fn().mockResolvedValue("typed"),
      }),
    );
    expect(result).toEqual({ kind: "value", value: "typed" });
  });

  it("prompt cancellation is a distinct canceled outcome", async () => {
    const result = await resolveSecretValue(
      "N",
      sources({
        promptHidden: vi.fn().mockResolvedValue(undefined),
      }),
    );
    expect(result).toEqual({ kind: "canceled" });
  });

  it("an empty prompted value is an error, not a cancellation", async () => {
    const result = await resolveSecretValue(
      "N",
      sources({
        promptHidden: vi.fn().mockResolvedValue(""),
      }),
    );
    expect(result.kind).toBe("error");
  });
});

describe("parseEnvSource", () => {
  it("keeps a value containing =", () => {
    expect(parseEnvSource('B="x=y"').entries).toEqual([{ name: "B", value: "x=y" }]);
  });

  it("parses double-quoted values", () => {
    expect(parseEnvSource('A="hello world"').entries).toEqual([
      { name: "A", value: "hello world" },
    ]);
  });

  it("parses a multiline quoted value as ONE entry, not an assignment per line", () => {
    const { entries } = parseEnvSource('A="first\nB=not-an-assignment\n"\nB=real');
    expect(entries).toEqual([
      { name: "A", value: "first\nB=not-an-assignment\n" },
      { name: "B", value: "real" },
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseEnvSource("A=1\r\nB=2\r\n").entries).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ]);
  });

  it("duplicate keys: first-insertion order, last value wins", () => {
    expect(parseEnvSource("A=1\nB=2\nA=3").entries).toEqual([
      { name: "A", value: "3" },
      { name: "B", value: "2" },
    ]);
  });

  it("preserves an empty value as an entry", () => {
    expect(parseEnvSource("EMPTY=\nREAL=x").entries).toEqual([
      { name: "EMPTY", value: "" },
      { name: "REAL", value: "x" },
    ]);
  });

  it("ignores comments and blank lines", () => {
    expect(parseEnvSource("# comment\n\nA=1\n").entries).toEqual([{ name: "A", value: "1" }]);
  });

  it("an empty source has zero entries", () => {
    expect(parseEnvSource("").entries).toEqual([]);
  });
});

describe("terminalSafe", () => {
  it("passes a plain name through", () => {
    expect(terminalSafe("OPENAI_API_KEY")).toBe("OPENAI_API_KEY");
  });

  it("JSON-quotes a name containing an ANSI escape", () => {
    expect(terminalSafe("BAD\x1b[31mNAME")).toBe(JSON.stringify("BAD\x1b[31mNAME"));
  });

  it("JSON-quotes a name containing a newline", () => {
    expect(terminalSafe("TWO\nLINES")).toBe(JSON.stringify("TWO\nLINES"));
  });

  it.each([
    ["a bare C1 CSI (U+009B)", 0x9b],
    ["DEL (U+007F)", 0x7f],
    ["the U+2028 line separator", 0x2028],
  ])("escapes %s, which JSON.stringify leaves raw", (_label, code) => {
    const character = String.fromCodePoint(code);
    const safe = terminalSafe(`A${character}B`);
    expect(safe).not.toContain(character);
    expect(safe).toContain(`\\u${code.toString(16).padStart(4, "0")}`);
  });
});

describe("stripOneTrailingNewline", () => {
  it("never touches interior newlines", () => {
    expect(stripOneTrailingNewline("a\nb\n")).toBe("a\nb");
    expect(stripOneTrailingNewline("a\r\nb")).toBe("a\r\nb");
  });
});
