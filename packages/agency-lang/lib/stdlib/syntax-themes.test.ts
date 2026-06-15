import { describe, it, expect } from "vitest";
import { resolveTheme, vscodeDarkTheme } from "./syntax-themes.js";

// Apply a theme's token style fn and return the raw ANSI for inspection.
const fg = (theme: any, token: string) => theme[token]("x");

describe("resolveTheme", () => {
  it("named built-ins differ from vscode-dark for the same token", () => {
    // monokai keyword is #f92672 (249,38,114) + bold; vscode-dark keyword is #569CD6 (86,156,214)
    expect(fg(resolveTheme("monokai"), "keyword")).toContain("38;2;249;38;114");
    expect(fg(resolveTheme("monokai"), "keyword")).toContain("\x1b[1m"); // bold
    expect(fg(resolveTheme("vscode-dark"), "keyword")).toContain("38;2;86;156;214");
  });

  it("resolves all 8 built-ins to a usable theme", () => {
    for (const name of ["vscode-dark", "github-dark", "monokai", "dracula", "nord", "github", "a11y-dark", "a11y-light"]) {
      expect(typeof (resolveTheme(name) as any).keyword).toBe("function");
    }
  });

  it("empty/undefined resolves to vscode-dark", () => {
    expect(resolveTheme(undefined)).toBe(vscodeDarkTheme);
    expect(resolveTheme("")).toBe(vscodeDarkTheme);
  });

  it("throws on an unknown scheme name", () => {
    expect(() => resolveTheme("not-a-theme")).toThrow(/Unknown color scheme/);
  });

  it("a custom ColorScheme overrides the targeted token and inherits the rest", () => {
    const t = resolveTheme({ keyword: { color: "#ff0000", styles: ["bold"] } });
    expect(fg(t, "keyword")).toContain("38;2;255;0;0");
    expect(fg(t, "keyword")).toContain("\x1b[1m");
    // string inherits vscode-dark (#CE9178 = 206,145,120)
    expect(fg(t, "string")).toContain("38;2;206;145;120");
  });

  it("maps a camelCase field to its hyphenated class", () => {
    const t = resolveTheme({ selectorTag: { color: "#00ff00" } });
    expect(fg(t, "selector-tag")).toContain("38;2;0;255;0");
  });

  it("throws on an invalid custom color (bad name or malformed hex)", () => {
    expect(() => resolveTheme({ keyword: { color: "totally-not-a-color" } })).toThrow(/Invalid color/);
    expect(() => resolveTheme({ keyword: { color: "#zzzzzz" } })).toThrow(/Invalid color/);
  });
});
