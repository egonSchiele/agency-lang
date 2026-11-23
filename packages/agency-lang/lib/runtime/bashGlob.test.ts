import { describe, it, expect } from "vitest";
import { bashGlobMayName } from "./bashGlob.js";

describe("bashGlobMayName", () => {
  it("reads `*`, `?`, and brackets", () => {
    expect(bashGlobMayName("*.json", "secrets.json")).toBe(true);
    expect(bashGlobMayName("*.ts", "secrets.json")).toBe(false);
    expect(bashGlobMayName("secret?.json", "secrets.json")).toBe(true);
    expect(bashGlobMayName("[rs]ecrets.json", "secrets.json")).toBe(true);
    expect(bashGlobMayName("[!s]ecrets.json", "secrets.json")).toBe(false);
    expect(bashGlobMayName("[^s]ecrets.json", "secrets.json")).toBe(false);
    expect(bashGlobMayName("[a-z]ecrets.json", "secrets.json")).toBe(true);
    expect(bashGlobMayName("[]]x", "]x")).toBe(true);
  });

  it("reads a plain value as the one name it spells", () => {
    expect(bashGlobMayName("notes.json", "notes.json")).toBe(true);
    expect(bashGlobMayName("notes.json", "secrets.json")).toBe(false);
  });

  it("reads a backslash as making the next character plain", () => {
    expect(bashGlobMayName("\\*.json", "*.json")).toBe(true);
    expect(bashGlobMayName("\\*.json", "a.json")).toBe(false);
  });

  it("finds a bracket's closing `]` past a character class inside it", () => {
    expect(bashGlobMayName("[[:alpha:]]ecrets.json", "secrets.json")).toBe(true);
    expect(bashGlobMayName("secret[[:alpha:]].json", "secrets.json")).toBe(true);
    expect(bashGlobMayName("[[=s=]]ecrets.json", "secrets.json")).toBe(true);
    expect(bashGlobMayName("[[.s.]]ecrets.json", "secrets.json")).toBe(true);
    expect(bashGlobMayName("[[:alpha:]]x", "]x")).toBe(true);
  });

  it("lets a later bracket close on a `]` an earlier scan stepped over", () => {
    // The first `[` has no close, so it is plain; the second holds `:` and `s`.
    expect(bashGlobMayName("[[:s:]ecrets.json", "[secrets.json")).toBe(true);
  });

  it("reads an unclosed bracket as a plain character", () => {
    expect(bashGlobMayName("a[b", "a[b")).toBe(true);
    expect(bashGlobMayName("a[b", "ab")).toBe(false);
  });

  it("has none of picomatch's syntax that bash lacks", () => {
    expect(bashGlobMayName("!notes.md", "secrets.json")).toBe(false);
    expect(bashGlobMayName("{a,secrets}.json", "secrets.json")).toBe(false);
    expect(bashGlobMayName("(a|secrets).json", "secrets.json")).toBe(false);
    expect(bashGlobMayName("@(secrets).json", "secrets.json")).toBe(false);
  });

  it("never matches a `/` with a wildcard, and `**` is `*`", () => {
    expect(bashGlobMayName("*", "a/b")).toBe(false);
    expect(bashGlobMayName("a?b", "a/b")).toBe(false);
    expect(bashGlobMayName("**", "a/b")).toBe(false);
    expect(bashGlobMayName("*/*.json", "config/secrets.json")).toBe(true);
    expect(bashGlobMayName("/proj/*", "/proj/config")).toBe(true);
  });

  it("matches a leading dot only with a plain dot", () => {
    expect(bashGlobMayName("*", ".env")).toBe(false);
    expect(bashGlobMayName("?env", ".env")).toBe(false);
    expect(bashGlobMayName("[.]env", ".env")).toBe(false);
    expect(bashGlobMayName(".*", ".env")).toBe(true);
    expect(bashGlobMayName("*/*", "a/.env")).toBe(false);
    expect(bashGlobMayName("*.env", "a.env")).toBe(true);
  });

  it("reads a value of any length", () => {
    expect(bashGlobMayName("*.jso[" + "n".repeat(70000) + "]", "secrets.json")).toBe(true);
    expect(bashGlobMayName("x".repeat(70000), "secrets.json")).toBe(false);
  });

  it("reads a long run of unclosed brackets in linear time", () => {
    const opens = "[".repeat(1_000_000);
    const started = Date.now();
    expect(bashGlobMayName(opens, opens)).toBe(true);
    expect(bashGlobMayName("[[:".repeat(300_000), "x")).toBe(false);
    expect(bashGlobMayName("[".repeat(1_000_000) + "[:a:]", "x")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("stays quick on a value built to make a matcher backtrack", () => {
    expect(bashGlobMayName("*?".repeat(14) + "Z", "{policy.json,session-policy.json}")).toBe(false);
    expect(bashGlobMayName("*a".repeat(5000) + "b", "a".repeat(5000))).toBe(false);
  });

  it("counts a comparison too long to finish as a name it may stand for", () => {
    // The `*` restarts at each of 20000 characters and compares up to 10000.
    const glob = "*" + "a".repeat(10000) + "b";
    expect(bashGlobMayName(glob, "a".repeat(20000))).toBe(true);
  });
});
