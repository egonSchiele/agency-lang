import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/memoryHost.js";
import { stripAnsi, visualWidth } from "./layout/ansi.js";
import {
  commandDetail,
  filePath,
  formatAgentTrace,
  lineRange,
  presentedToolNames,
  printAgentTrace,
  text,
  traceOptionsForHost,
} from "./agentToolTrace.js";

const plain = { columns: 80, color: false };

const tasks = [
  { id: "1", text: "Verify rankings", status: "completed" },
  { id: "2", text: "Check availability", status: "in_progress" },
  { id: "3", text: "Compare hardware", status: "pending" },
];

describe("custom presentations", () => {
  it("announces a subagent once and labels its completion", () => {
    expect(
      formatAgentTrace(
        { kind: "toolStart", toolName: "researchAgent", args: { userMsg: "Find sources" } },
        plain,
      ),
    ).toBe("");
    expect(
      formatAgentTrace(
        { kind: "agentStart", toolName: "researchAgent", message: "Find sources" },
        plain,
      ),
    ).toBe("→ Research  researchAgent\n  │ Find sources");
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "researchAgent", value: "Found them", outcome: "plain" },
        plain,
      ),
    ).toBe("✓ Research finished  researchAgent\n  │ Found them");
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "researchAgent", value: "Unavailable", outcome: "failure" },
        plain,
      ),
    ).toBe("✗ Research failed  researchAgent\n  │ Unavailable");
  });

  it("uses blue starts and green completions, including plain returns", () => {
    const options = { columns: 80, color: true };
    const start = formatAgentTrace({ kind: "toolStart", toolName: "echo", args: {} }, options);
    const end = formatAgentTrace(
      { kind: "toolEnd", toolName: "echo", value: "done", outcome: "plain" },
      options,
    );
    expect(start).toContain("\x1b[34m");
    expect(start).not.toContain("\x1b[32m");
    expect(end).toContain("\x1b[32m");
    expect(end).toContain("\x1b[2mdone");
    expect(stripAnsi(end)).toBe("✓ Tool finished  echo\n  │ done");
  });
});

describe("search sources", () => {
  const sources = [
    {
      title: "Release notes",
      url: "https://example.com/release",
      description: "Do not dump snippets",
    },
    { url: "https://example.com/model" },
  ];
  it("shares source rows between client results and hosted records", () => {
    const rows =
      "  │ 2 sources\n  │ 1. Release notes\n  │    https://example.com/release\n  │ 2. https://example.com/model";
    const client = formatAgentTrace(
      {
        kind: "toolEnd",
        toolName: "catalog_search",
        provider: "Catalog",
        outcome: "plain",
        value: sources,
      },
      plain,
    );
    expect(client).toBe("✓ Web search  catalog_search\n  │ Catalog\n" + rows);
    const hosted = formatAgentTrace(
      { kind: "hostedSearch", result: { tool: "web_search", provider: "openrouter", sources } },
      plain,
    );
    expect(hosted).toBe(
      "⌕ Web search  web_search\n  │ openrouter\n  │ Queries not reported\n" + rows,
    );
    expect(client + hosted).not.toMatch(/Tool finished|description|Do not dump snippets/);
  });

  it("bounds source lists and keeps failures on the custom path", () => {
    const sources = Array.from({ length: 7 }, (_, index) => ({
      title: `Source ${index + 1}`,
      url: `https://example.com/${index + 1}`,
    }));
    const output = formatAgentTrace(
      {
        kind: "toolEnd",
        toolName: "catalog_search",
        provider: "Catalog",
        outcome: "success",
        value: sources,
      },
      plain,
    );
    expect(output).toContain("7 sources");
    expect(output).toContain("5. Source 5");
    expect(output).toContain("… 2 more sources");
    expect(output).not.toContain("Source 6");
    expect(
      formatAgentTrace(
        {
          kind: "toolEnd",
          toolName: "catalog_search",
          provider: "Catalog",
          outcome: "failure",
          value: "Unavailable",
        },
        plain,
      ),
    ).toBe("✗ Web search  catalog_search\n  │ Catalog\n  │ Unavailable");
  });

  it("distinguishes zero sources from unreported or malformed sources", () => {
    const render = (value: unknown) =>
      formatAgentTrace(
        {
          kind: "toolEnd",
          toolName: "catalog_search",
          provider: "Catalog",
          outcome: "plain",
          value,
        },
        plain,
      );
    expect(render([])).toBe("✓ Web search  catalog_search\n  │ Catalog\n  │ 0 sources");
    for (const value of [null, "raw result", [null, { title: "Missing URL" }]]) {
      expect(render(value)).toBe(
        "✓ Web search  catalog_search\n  │ Catalog\n  │ Sources not reported",
      );
    }
    expect(
      formatAgentTrace(
        { kind: "hostedSearch", result: { tool: "web_search", sources: [null] } },
        plain,
      ),
    ).not.toContain("0 sources");
  });

  it("sanitizes source titles and URLs and wraps them without leaking styles", () => {
    const value = [
      {
        title: "Notes\x1b[2J\nsecond line",
        url: "https://example.com/" + "path".repeat(20) + "\x07",
      },
    ];
    const output = formatAgentTrace(
      { kind: "toolEnd", toolName: "search", provider: "Catalog", outcome: "success", value },
      { columns: 40, color: true },
    );
    expect(output).not.toContain("\x1b[2J");
    expect(output).not.toContain("\x07");
    expect(stripAnsi(output)).toContain("second line");
    expect(stripAnsi(output)).toContain("�");
    expect(output.split("\n").every((line) => visualWidth(line) <= 40)).toBe(true);
  });
});

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
    ).toBe("✗ Tasks failed  todoWrite\n  │ Update refused");
  });

  it("falls back for sparse task arrays supplied by JavaScript", () => {
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "todoWrite", value: Array(1), outcome: "plain" },
        plain,
      ),
    ).toBe("· Task result  todoWrite\n  │ [null]");
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
    expect(output).toContain("· Task result  todoWrite");
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

  it("omits blank hosted queries without changing valid query text", () => {
    const render = (queries: string[]) =>
      formatAgentTrace({ kind: "hostedSearch", result: { tool: "web_search", queries } }, plain);
    expect(render(["", " \t\n "])).toBe(
      "⌕ Web search  web_search\n  │ Provider not reported\n  │ Queries not reported",
    );
    expect(render(["", '  "release notes"  ', "  "])).toBe(
      '⌕ Web search  web_search\n  │ Provider not reported · 1 query\n  │ ·   "release notes"  ',
    );
  });

  it.each([null, {}, { tool: "code_interpreter" }])(
    "skips unsupported hosted records (%j)",
    (result) => {
      expect(formatAgentTrace({ kind: "hostedSearch", result }, plain)).toBe("");
    },
  );

  it.each([
    ["catalog_search", "Catalog provider"],
    ["renamed_search", "Renamed provider"],
  ])("labels the %s client search", (toolName, provider) => {
    const query = "q".repeat(140);
    const output = formatAgentTrace(
      { kind: "toolStart", toolName, provider, args: { query } },
      { columns: 200, color: false },
    );
    expect(output).toBe(`⌕ Web search  ${toolName}\n  │ ${provider} · 1 query\n  │ · ${query}`);
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

  it.each([null, {}, { query: 3 }])(
    "keeps a custom search display for malformed args (%j)",
    (args) => {
      expect(
        formatAgentTrace(
          { kind: "toolStart", toolName: "web_search_tavily", provider: "Tavily", args },
          plain,
        ),
      ).toBe("⌕ Web search  web_search_tavily\n  │ Tavily\n  │ Queries not reported");
    },
  );
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
    ["plain", "✓ Tool finished"],
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
    ).toBe("✓ Tool finished  noop");
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
      "✓ Tool finished  custom\n  │ [1,2]",
      '✓ Tool finished  custom\n  │ {"count":2}',
      "✓ Tool finished  custom\n  │ [unserializable value]",
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
        "✓ Tool finished  custom\n  │ " + "b".repeat(100) + (length > 100 ? "…" : ""),
      );
    }
  });

  it("keeps emoji intact at argument and result preview limits", () => {
    const options = { columns: 200, color: false };
    const argument = "a".repeat(48) + "😀tail";
    expect(
      formatAgentTrace(
        { kind: "toolStart", toolName: "custom", args: { text: argument } },
        options,
      ),
    ).toBe('● Tool call  custom\n  │ text: "' + "a".repeat(48) + "😀…");
    const result = "b".repeat(99) + "😀";
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "custom", value: result, outcome: "plain" },
        options,
      ),
    ).toBe("✓ Tool finished  custom\n  │ " + result);
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "custom", value: result + "tail", outcome: "plain" },
        options,
      ),
    ).toBe("✓ Tool finished  custom\n  │ " + result + "…");
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
    expect(traceOptionsForHost(host)).toEqual({
      columns: 40,
      color: false,
      toolNames: false,
      spillSource: expect.any(Function),
    });
    printAgentTrace(host, { kind: "toolStart", toolName: "noop", args: {} });
    printAgentTrace(host, { kind: "hostedSearch", result: { tool: "unsupported" } });
    expect(host.state.output).toEqual(["● Tool call  noop\n\n"]);
    host.terminal.size = () => null;
    expect(traceOptionsForHost(host).columns).toBe(80);
    host.terminal.size = () => ({ columns: Number.NaN, rows: 24 });
    expect(traceOptionsForHost(host).columns).toBe(80);
  });
});

describe("summary presentations", () => {
  const end = (toolName: string, args: object, value: unknown, extra: object = {}) =>
    formatAgentTrace(
      { kind: "toolEnd", toolName, args, value, outcome: "success", ...extra },
      plain,
    );
  const start = (toolName: string, args: object) =>
    formatAgentTrace({ kind: "toolStart", toolName, args }, plain);

  it("prints one line for read, with the directory and the range only when set", () => {
    expect(start("read", { filename: "a.md" })).toBe("");
    expect(end("read", { filename: "a.md", dir: "." }, "text", { timeTaken: 12 })).toBe(
      "✓ Read a.md",
    );
    expect(end("read", { filename: "a.md", dir: "packages/x" }, "text")).toBe(
      "✓ Read packages/x/a.md",
    );
    expect(end("read", { filename: "a.md", offset: 460, limit: 120 }, "t")).toBe(
      "✓ Read a.md lines 460–579",
    );
    expect(end("read", { filename: "a.md", offset: 0, limit: 120 }, "t")).toBe(
      "✓ Read a.md lines 1–120",
    );
    expect(end("read", { filename: "a.md", offset: 460, limit: 0 }, "t")).toBe(
      "✓ Read a.md lines 460–end",
    );
  });

  it("prints a start and an end for a two-line tool, with elapsed time from one second", () => {
    expect(start("safeBash", { command: "pnpm run typecheck" })).toBe("● Run pnpm run typecheck");
    expect(end("safeBash", { command: "pnpm run typecheck" }, "", { timeTaken: 14200 })).toBe(
      "✓ Run pnpm run typecheck · 14s",
    );
    expect(end("safeBash", { command: "ls" }, "", { timeTaken: 900 })).toBe("✓ Run ls");
    expect(end("read", { filename: "a.md" }, "t", { timeTaken: 5000 })).toBe("✓ Read a.md");
  });

  it("shows only the first line of a multi-line command", () => {
    expect(start("safeBash", { command: "echo a\necho b\necho c" })).toBe("● Run echo a…");
  });

  it("puts a failure message in full under the line and drops the result summary", () => {
    const out = formatAgentTrace(
      {
        kind: "toolEnd",
        toolName: "grep",
        args: { pattern: "x" },
        value: "Tool call rejected: no",
        outcome: "failure",
      },
      plain,
    );
    expect(out).toBe("✗ Grep x\n  │ Tool call rejected: no");
  });

  it("skips a shown argument the call did not pass, and prints numbers and arrays plainly", () => {
    expect(end("ghPrGet", { number: 1310 }, {})).toBe("✓ gh pr get #1310");
    expect(start("gitAdd", { paths: ["a", "b"] })).toBe("● git add a b");
    expect(start("gitAdd", { all: true })).toBe("● git add --all");
    expect(start("gitCommit", { message: "Add summary tier\n\nMore detail" })).toBe(
      "● git commit Add summary tier…",
    );
  });

  it("prints nothing for a silent tool", () => {
    expect(start("question", { prompt: "Which?" })).toBe("");
    expect(end("question", { prompt: "Which?" }, "that one")).toBe("");
  });

  it("keeps the generic display, with its tool name, for an unknown tool", () => {
    expect(start("mystery", { a: 1 })).toBe("● Tool call  mystery\n  │ a: 1");
  });

  it("appends the tool name to a summary line only when asked", () => {
    const debug = { ...plain, toolNames: true };
    expect(
      formatAgentTrace(
        {
          kind: "toolEnd",
          toolName: "read",
          args: { filename: "a.md" },
          value: "t",
          outcome: "success",
        },
        debug,
      ),
    ).toBe("✓ Read a.md  read");
  });

  it("treats a plain return as a success", () => {
    expect(
      formatAgentTrace(
        {
          kind: "toolEnd",
          toolName: "read",
          args: { filename: "a.md" },
          value: "t",
          outcome: "plain",
        },
        plain,
      ),
    ).toBe("✓ Read a.md");
  });

  it("builds parts with the shared helpers", () => {
    expect(text(3)).toBe("3");
    expect(text(["a", "b"])).toBe("a b");
    expect(text({ nested: true })).toBeNull();
    expect(text("")).toBeNull();
    expect(filePath({ filename: "a.md", dir: "lib/" })).toBe("lib/a.md");
    expect(filePath({ dir: "lib" })).toBeNull();
    expect(lineRange({ offset: 0, limit: 0 })).toBeNull();
    expect(commandDetail("out", "err")).toBe("err");
    expect(commandDetail("out", "")).toBe("out");
    expect(commandDetail("", "")).toBeNull();
    expect(
      commandDetail('[Output of "make" too long: 900 lines.\n--- first 10 lines ---\nx', ""),
    ).toBe('[Output of "make" too long: 900 lines.');
  });
});

describe("result summarizers", () => {
  const end = (
    toolName: string,
    args: object,
    value: unknown,
    outcome: "success" | "failure" | "plain" = "success",
  ) => formatAgentTrace({ kind: "toolEnd", toolName, args, value, outcome }, plain);

  it("counts grep lines and distinct files, or files alone for a filesOnly search", () => {
    const matches = [
      { file: "a", line: 1, text: "" },
      { file: "a", line: 2, text: "" },
      { file: "b", line: 1, text: "" },
    ];
    expect(end("grep", { pattern: "x", path: "lib" }, matches)).toBe(
      "✓ Grep x in lib · 3 lines in 2 files",
    );
    expect(end("grep", { pattern: "x", filesOnly: true }, ["a", "b", "c"])).toBe(
      "✓ Grep x files only · 3 files",
    );
    expect(end("grep", { pattern: "x" }, [{ file: "a", line: 1, text: "" }])).toBe(
      "✓ Grep x · 1 line in 1 file",
    );
  });

  it("sums grepSpill lines across pattern groups", () => {
    const grouped = [
      {
        pattern: "a",
        matches: [
          { file: "n", line: 1, text: "" },
          { file: "n", line: 2, text: "" },
        ],
      },
      { pattern: "b", matches: [] },
    ];
    expect(end("grepSpill", { pattern: "a", filename: "n.log" }, grouped)).toBe(
      "✓ Grep a in n.log · 2 lines",
    );
  });

  it("reports typecheck as clean or as counts, red when there are errors", () => {
    expect(end("typecheck", { source: "x" }, { errors: [], warnings: [] })).toBe(
      "✓ Typecheck · clean",
    );
    expect(end("typecheck", { source: "x" }, { errors: [1, 2, 3], warnings: [1] })).toBe(
      "✗ Typecheck · 3 errors, 1 warning",
    );
  });

  it("reports test cases passed and failed", () => {
    const report = { pass: false, cases: [{ pass: true }, { pass: true }, { pass: false }] };
    expect(end("testFile", { filename: "t.json" }, report)).toBe(
      "✗ Test t.json · 2 passed, 1 failed",
    );
    expect(end("testFile", { filename: "t.json" }, { pass: true, cases: [{ pass: true }] })).toBe(
      "✓ Test t.json · 1 passed",
    );
  });

  it("shows the exit code and stderr for a safeBash failure, and the raw message otherwise", () => {
    const message = JSON.stringify({
      command: "make",
      exitCode: 2,
      stderr: "boom\nbang",
      stdout: "",
    });
    expect(end("safeBash", { command: "make" }, message, "failure")).toBe(
      "✗ Run make · exit 2\n  │ boom\n  │ bang",
    );
    expect(end("safeBash", { command: "make" }, "rejected by policy", "failure")).toBe(
      "✗ Run make\n  │ rejected by policy",
    );
    const stdoutOnly = JSON.stringify({
      command: "tsc",
      exitCode: 2,
      stderr: "",
      stdout: "src/a.ts: error",
    });
    expect(end("safeBash", { command: "tsc" }, stdoutOnly, "failure")).toBe(
      "✗ Run tsc · exit 2\n  │ src/a.ts: error",
    );
  });

  it("turns a nonzero exit on a plain command result red", () => {
    const result = { exitCode: 128, stdout: "", stderr: "fatal: bad" };
    expect(end("exec", { command: "git", args: ["log"] }, result, "plain")).toBe(
      "✗ Run git log · exit 128\n  │ fatal: bad",
    );
    expect(end("exec", { command: "ls" }, { exitCode: 0, stdout: "x", stderr: "" }, "plain")).toBe(
      "✓ Run ls · exit 0",
    );
  });

  it("sizes a write and counts edits", () => {
    expect(end("write", { filename: "a.md", content: "x".repeat(2100) }, null)).toBe(
      "✓ Write a.md · 2.1 KB",
    );
    expect(end("write", { filename: "a.md", content: "x", mode: "append" }, null)).toBe(
      "✓ Write a.md append · 1 B",
    );
    expect(end("edit", { filename: "a.ts", edits: [{}, {}, {}] }, null)).toBe(
      "✓ Edit a.ts · 3 edits",
    );
  });
});

describe("table rows", () => {
  it("shows the spill source in place of the saved name, and the name when unknown", () => {
    const args = { filename: "2026-01-01T00-00-00-000Z-abcdef.log", offset: 1, limit: 200 };
    const event = {
      kind: "toolEnd" as const,
      toolName: "readSpill",
      args,
      value: "t",
      outcome: "success" as const,
    };
    expect(formatAgentTrace(event, { ...plain, spillSource: () => "pnpm run typecheck" })).toBe(
      "✓ Read output of pnpm run typecheck lines 1–200",
    );
    expect(formatAgentTrace(event, { ...plain, spillSource: () => null })).toBe(
      "✓ Read 2026-01-01T00-00-00-000Z-abcdef.log lines 1–200",
    );
  });

  it("marks a forced checkout and a staged diff", () => {
    expect(
      formatAgentTrace(
        { kind: "toolStart", toolName: "gitCheckout", args: { target: "main", force: true } },
        plain,
      ),
    ).toBe("● git checkout main --force");
    expect(
      formatAgentTrace(
        {
          kind: "toolEnd",
          toolName: "gitDiff",
          args: { staged: true },
          value: {},
          outcome: "success",
        },
        plain,
      ),
    ).toBe("✓ git diff --staged");
  });

  it("appends the fetch path to its base url", () => {
    expect(
      formatAgentTrace(
        {
          kind: "toolStart",
          toolName: "fetchMarkdown",
          args: { baseUrl: "https://x.test", path: "/doc" },
        },
        plain,
      ),
    ).toBe("● Fetch https://x.test/doc");
  });

  it("adds elapsed time to a subagent completion", () => {
    const out = formatAgentTrace(
      {
        kind: "toolEnd",
        toolName: "codeAgent",
        value: "done",
        outcome: "success",
        timeTaken: 134000,
      },
      plain,
    );
    expect(out).toBe("✓ Code finished · 2m 14s  codeAgent\n  │ done");
  });

  it("exposes the rows for the coverage test", () => {
    expect(presentedToolNames()).toContain("read");
    expect(presentedToolNames()).toContain("todoWrite");
  });
});
