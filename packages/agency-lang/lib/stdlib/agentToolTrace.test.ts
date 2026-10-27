import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memoryHost.js";
import { stripAnsi, visualWidth } from "./layout/ansi.js";
import { formatAgentTrace, printAgentTrace, traceOptionsForHost } from "./agentToolTrace.js";

const plain = { columns: 80, color: false };

describe("ordinary agent tool output", () => {
  it("puts named arguments on their own rows", () => {
    expect(
      formatAgentTrace(
        {
          kind: "toolStart",
          toolName: "readFile",
          args: {
            path: "docs/models.md",
            start: 2,
          },
        },
        plain,
      ),
    ).toBe('● Tool call  readFile\n  │ path: "docs/models.md"\n  │ start: 2');
  });

  it.each([
    ["success", "✓ Tool finished"],
    ["failure", "✗ Tool failed"],
    ["plain", "· Tool returned"],
  ] as const)("keeps the %s outcome attached to its tool name", (outcome, heading) => {
    expect(
      formatAgentTrace({ kind: "toolEnd", toolName: "readFile", value: "answer", outcome }, plain),
    ).toBe(`${heading}  readFile\n  │ answer`);
  });

  it("keeps multiline failures complete and indented", () => {
    const reason = "file missing\n" + "x".repeat(120);
    const output = formatAgentTrace(
      { kind: "toolEnd", toolName: "readFile", value: reason, outcome: "failure" },
      plain,
    );
    expect(output).toContain("  │ file missing\n  │ ");
    expect(
      output
        .split("\n")
        .slice(1)
        .map((line) => line.slice(4))
        .join(""),
    ).toBe("file missing" + "x".repeat(120));
  });

  it.each([null, undefined, ""])("still names a tool with an empty result (%s)", (value) => {
    expect(
      formatAgentTrace({ kind: "toolEnd", toolName: "noop", value, outcome: "plain" }, plain),
    ).toBe("· Tool returned  noop");
  });

  it("handles empty and non-object arguments", () => {
    expect(formatAgentTrace({ kind: "toolStart", toolName: "noop", args: {} }, plain)).toBe(
      "● Tool call  noop",
    );
    expect(formatAgentTrace({ kind: "toolStart", toolName: "custom", args: [1, 2] }, plain)).toBe(
      "● Tool call  custom\n  │ [1,2]",
    );
  });

  it("serializes arrays and objects and reports a circular preview", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const values = [[1, 2], { count: 2 }, circular];
    const outputs = values.map((value) =>
      formatAgentTrace({ kind: "toolEnd", toolName: "custom", value, outcome: "plain" }, plain),
    );
    expect(outputs).toEqual([
      "· Tool returned  custom\n  │ [1,2]",
      '· Tool returned  custom\n  │ {"count":2}',
      "· Tool returned  custom\n  │ [unserializable value]",
    ]);
  });

  it("limits generic previews without truncating a value at the limit", () => {
    const options = { columns: 200, color: false };
    expect(
      formatAgentTrace(
        { kind: "toolStart", toolName: "custom", args: { text: "a".repeat(60) } },
        options,
      ),
    ).toBe('● Tool call  custom\n  │ text: "' + "a".repeat(49) + "…");
    for (const length of [100, 101]) {
      const output = formatAgentTrace(
        { kind: "toolEnd", toolName: "custom", value: "b".repeat(length), outcome: "plain" },
        options,
      );
      expect(output).toBe(
        "· Tool returned  custom\n  │ " + "b".repeat(100) + (length > 100 ? "…" : ""),
      );
    }
  });

  it("preserves session diagnostics below the warning", () => {
    expect(
      formatAgentTrace(
        {
          kind: "sessionSaveFailure",
          message: 'dir must not be empty.\nUse "." for the current directory.',
        },
        plain,
      ),
    ).toBe(
      '! Session not saved\n  │ dir must not be empty.\n  │ Use "." for the current directory.',
    );
  });
});

describe("terminal rendering", () => {
  it.each([40, 80, 1])("wraps complete failure text at %s columns", (columns) => {
    const value = "abcdef ".repeat(30).trim();
    const output = formatAgentTrace(
      { kind: "toolEnd", toolName: "longToolName", value, outcome: "failure" },
      { columns, color: true },
    );
    expect(output.split("\n").every((line) => visualWidth(line) <= columns)).toBe(true);
    expect(stripAnsi(output).replace(/\s|│/g, "")).toContain(value.replace(/\s/g, ""));
    expect(
      output
        .split("\n")
        .filter((line) => line.includes("\x1b"))
        .every((line) => line.endsWith("\x1b[0m")),
    ).toBe(true);
  });

  it("sanitizes headers, keys, and values before applying its own styles", () => {
    const output = formatAgentTrace(
      { kind: "toolStart", toolName: "evil\x1b[2J\nname", args: { "key\x1b[31m": "value" } },
      plain,
    );
    expect(output).not.toContain("\x1b");
    expect(output).toContain("\n  name");
    expect(output).toContain('  │ key: "value"');
    const warning = formatAgentTrace(
      { kind: "sessionSaveFailure", message: "a\r\nb\tc\x07\u009b" },
      plain,
    );
    expect(warning).toContain("  │ a\n  │ b    c��");
  });

  it("reads the supplied host on every print and separates blocks once", () => {
    const host = memoryHost();
    host.terminal.size = () => ({ columns: 40, rows: 24 });
    host.terminal.supportsColor = () => false;
    expect(traceOptionsForHost(host)).toEqual({ columns: 40, color: false });
    printAgentTrace(host, { kind: "toolStart", toolName: "noop", args: {} });
    printAgentTrace(host, { kind: "hostedSearch", result: { tool: "unsupported" } });
    expect(host.state.output).toEqual(["● Tool call  noop\n\n"]);
    host.terminal.size = () => null;
    expect(traceOptionsForHost(host).columns).toBe(80);
    host.terminal.size = () => ({ columns: Number.NaN, rows: 24 });
    expect(traceOptionsForHost(host).columns).toBe(80);
  });
});
