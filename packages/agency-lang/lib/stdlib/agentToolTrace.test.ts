import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memoryHost.js";
import { stripAnsi, visualWidth } from "./layout/ansi.js";
import { formatAgentTrace, printAgentTrace, traceOptionsForHost } from "./agentToolTrace.js";

const plain = { columns: 80, color: false };

const tasks = [
  { id: "1", text: "Verify rankings", status: "completed" },
  { id: "2", text: "Check availability", status: "in_progress" },
  { id: "3", text: "Compare hardware", status: "pending" },
];

describe("task lists", () => {
  it.each(["todoWrite", "todoAdd", "todoUpdate", "todoList"])(
    "shows the full %s snapshot",
    (toolName) => {
      expect(formatAgentTrace({ kind: "toolStart", toolName, args: { todos: tasks } }, plain)).toBe(
        "",
      );
      const heading = toolName === "todoList" ? "Tasks" : "✓ Tasks updated";
      expect(
        formatAgentTrace({ kind: "toolEnd", toolName, value: tasks, outcome: "plain" }, plain),
      ).toBe(
        [
          `${heading}  ${toolName}`,
          "  │ 1/3 complete",
          "  │ ✓ Verify rankings",
          "  │ › Check availability · in progress",
          "  │ ○ Compare hardware",
        ].join("\n"),
      );
    },
  );

  it("strikes only completed task text and wraps the whole list", () => {
    const text = "long-task-".repeat(20);
    const value = [...tasks, { id: "4", text, status: "pending" }];
    const output = formatAgentTrace(
      { kind: "toolEnd", toolName: "todoWrite", value, outcome: "success" },
      { columns: 40, color: true },
    );
    expect(output).toContain("\x1b[2m\x1b[9mVerify rankings\x1b[0m");
    expect(output.match(/\x1b\[9m/g)).toHaveLength(1);
    expect(output.split("\n").every((line) => visualWidth(line) <= 40)).toBe(true);
    expect(stripAnsi(output).replace(/\s|│/g, "")).toContain(text);
    expect(stripAnsi(output)).toContain("1/4 complete");
  });

  it("shows empty, completed, and multiple active lists independently", () => {
    const render = (value: unknown) =>
      formatAgentTrace({ kind: "toolEnd", toolName: "todoWrite", value, outcome: "plain" }, plain);
    expect(render([])).toBe("✓ Tasks updated  todoWrite\n  │ 0/0 complete\n  │ No tasks");
    expect(render(tasks.map((task) => ({ ...task, status: "completed" })))).toContain(
      "3/3 complete",
    );
    const active = render(tasks.map((task) => ({ ...task, status: "in_progress" })));
    expect(active).toContain("0/3 complete");
    expect(active.match(/· in progress/g)).toHaveLength(3);
    expect(render([tasks[2]])).toBe(
      "✓ Tasks updated  todoWrite\n  │ 0/1 complete\n  │ ○ Compare hardware",
    );
  });

  it("keeps a failed update attached to its name", () => {
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "todoWrite", value: "Update refused", outcome: "failure" },
        plain,
      ),
    ).toBe("✗ Tool failed  todoWrite\n  │ Update refused");
  });

  it.each([
    null,
    {},
    [null],
    [{ text: "Missing id", status: "pending" }],
    [{ id: "1", text: "Unknown", status: "done" }],
  ])("falls back for malformed tasks (%j)", (value) => {
    const output = formatAgentTrace(
      { kind: "toolEnd", toolName: "todoWrite", value, outcome: "plain" },
      plain,
    );
    expect(output).toContain("· Tool returned  todoWrite");
    expect(output).not.toContain("Tasks updated");
  });
});

describe("web searches", () => {
  const queries = [
    'site.anthropic.com "Fable" "5.1"',
    'site.moonshot.ai "K3.1"',
    'site.anthropic.com "Opus 5.5" "October"',
    'site.blog.google "Gemini 4" "Argon"',
  ];

  it("shows hosted query strings with their quotes intact", () => {
    const output = formatAgentTrace(
      {
        kind: "hostedSearch",
        result: { tool: "web_search", provider: "openai-responses", queries },
      },
      plain,
    );
    expect(output).toBe(
      [
        "⌕ Web search  web_search",
        "  │ openai-responses · 4 queries",
        ...queries.map((query) => `  │ · ${query}`),
      ].join("\n"),
    );
  });

  it("wraps full multiline queries and indents continuations", () => {
    const query = "abcdefgh".repeat(20) + "\nsecond line";
    const output = formatAgentTrace(
      { kind: "hostedSearch", result: { tool: "web_search", queries: [query] } },
      { columns: 40, color: false },
    );
    expect(output).toContain("Provider not reported · 1 query");
    expect(output).toContain("\n  │   second line");
    expect(output.split("\n").every((line) => visualWidth(line) <= 40)).toBe(true);
    expect(output.replace(/\s|│/g, "")).toContain(query.replace(/\s/g, ""));
  });

  it.each([undefined, [], [null, 3]])(
    "reports missing queries (%j) without inventing a count",
    (queries) => {
      const output = formatAgentTrace(
        { kind: "hostedSearch", result: { tool: "web_search", queries } },
        plain,
      );
      expect(output).toBe(
        "⌕ Web search  web_search\n  │ Provider not reported\n  │ Queries not reported",
      );
    },
  );

  it("counts only query strings and never infers hosted success from raw data", () => {
    const output = formatAgentTrace(
      {
        kind: "hostedSearch",
        result: {
          tool: "web_search",
          provider: "custom\x1b[2J\nprovider",
          queries: ["one", false, "two"],
          raw: { status: "failed", secret: "raw must stay hidden" },
        },
      },
      plain,
    );
    expect(output).toContain("custom\n  │ provider · 2 queries");
    expect(output).not.toContain("\x1b");
    expect(output).not.toMatch(/✓|finished|raw must stay hidden/);
    expect(output).toContain("  │ · one\n  │ · two");
  });

  it.each([null, {}, { tool: "code_interpreter" }])(
    "skips unsupported hosted records (%j)",
    (result) => {
      expect(formatAgentTrace({ kind: "hostedSearch", result }, plain)).toBe("");
    },
  );

  it.each([
    ["web_search_tavily", "Tavily"],
    ["web_search_brave", "Brave"],
  ])("labels the %s client search", (toolName, provider) => {
    const query = "q".repeat(140);
    const output = formatAgentTrace(
      { kind: "toolStart", toolName, args: { query } },
      { columns: 200, color: false },
    );
    expect(output).toBe(`⌕ Searching web  ${toolName}\n  │ ${provider} · 1 query\n  │ · ${query}`);
    expect(
      formatAgentTrace({ kind: "toolEnd", toolName, value: "result", outcome: "success" }, plain),
    ).toBe(`✓ Tool finished  ${toolName}\n  │ result`);
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName, value: "unavailable", outcome: "failure" },
        plain,
      ),
    ).toBe(`✗ Tool failed  ${toolName}\n  │ unavailable`);
  });

  it.each([null, {}, { query: 3 }])("falls back for malformed client search args (%j)", (args) => {
    expect(
      formatAgentTrace({ kind: "toolStart", toolName: "web_search_tavily", args }, plain),
    ).toContain("● Tool call  web_search_tavily");
  });
});

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
