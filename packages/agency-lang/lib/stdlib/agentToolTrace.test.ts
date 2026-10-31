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

describe("compact tool activity", () => {
  const start = (toolName: string, args: unknown) =>
    formatAgentTrace({ kind: "toolStart", toolName, args }, { ...plain, columns: 240 });

  it.each([
    [{}, "● Reading  notes.md"],
    [{ offset: 460, limit: 120 }, "● Reading  notes.md · lines 460–579"],
    [{ offset: 460 }, "● Reading  notes.md · lines 460–end"],
    [{ limit: 20 }, "● Reading  notes.md · lines 1–20"],
    [{ offset: 0, limit: 0 }, "● Reading  notes.md"],
  ])("shows the requested read extent for %j", (range, expected) => {
    expect(start("read", { filename: "notes.md", ...range })).toBe(expected);
  });

  it("keeps the full path and distinguishes documentation and saved output", () => {
    const filename = "a-long-directory/".repeat(4) + "notes.md";
    expect(start("read", { filename, dir: "docs" })).toContain("docs/" + filename);
    expect(start("agencyGuide", { filename: "handlers.md" })).toContain("agencyGuide: handlers.md");
    expect(start("readSpill", { filename: "output.log", offset: 50 })).toContain(
      "saved output output.log · lines 50–end",
    );
  });

  it("shows search scope and active modes without default argument rows", () => {
    const text = start("grep", {
      pattern: "registers|plugin|local serve",
      dir: "docs/models.md",
      flags: "i",
      maxResults: 30,
      allowedPaths: [],
      ignoreCase: true,
      wholeWord: false,
      filesOnly: false,
      invert: false,
    });
    expect(text).toBe('● Searching  "registers|plugin|local serve" in docs/models.md');
    expect(
      start("grep", { pattern: "x", path: "src", wholeWord: true, invert: true, filesOnly: true }),
    ).toContain("whole words · files only · nonmatching lines");
    expect(start("grep", { pattern: "x", path: "src", respectGitignore: false })).toContain(
      "including ignored files",
    );
  });

  it("distinguishes glob, recursive listings, and every saved-output pattern", () => {
    expect(start("glob", { pattern: "**/*.ts", dir: "src" })).toContain('"**/*.ts" in src');
    expect(start("ls", { dir: "src", recursive: true })).toContain("recursive");
    const output = start("grepSpill", {
      filename: "output.log",
      pattern: "first",
      morePatterns: ["second", "third"],
    });
    for (const value of ["output.log", "first", "second", "third"]) {
      expect(output).toContain(value);
    }
  });

  it("preserves unsupported grep flags so a corrected retry looks different", () => {
    const text = start("grep", { pattern: "x", flags: "-i", ignoreCase: true });
    expect(text).toContain('flags "-i"');
    expect(text).not.toBe(start("grep", { pattern: "x", flags: "i", ignoreCase: true }));
  });

  it("distinguishes an explicit process directory from the agent directory", () => {
    expect(start("safeBash", { command: "pwd", cwd: "." })).toContain("in .");
    expect(start("safeBash", { command: "pwd" })).not.toContain("in .");
    expect(start("safeBash", { command: "pwd", cwd: "" })).not.toContain("in ");
  });

  it.each(["read", "readSpill", "grep", "grepSpill", "glob", "ls", "agencyGuide"])(
    "suppresses routine %s completions but keeps failures",
    (toolName) => {
      expect(
        formatAgentTrace(
          { kind: "toolEnd", toolName, value: "contents", outcome: "success" },
          plain,
        ),
      ).toBe("");
      expect(
        formatAgentTrace(
          { kind: "toolEnd", toolName, value: "permission denied", outcome: "failure" },
          plain,
        ),
      ).toContain("permission denied");
    },
  );

  it("reports slow reads without printing the contents or inventing call context", () => {
    const text = formatAgentTrace(
      { kind: "toolEnd", toolName: "read", value: "contents", outcome: "success", timeTaken: 1250 },
      plain,
    );
    expect(text).toContain("read");
    expect(text).toContain("1.3s");
    expect(text).not.toContain("contents");
  });

  it("keeps mutation targets and command arguments while omitting write bodies", () => {
    expect(
      start("write", { filename: "a.md", dir: "docs", content: "secret body", mode: "append" }),
    ).toBe("● Writing  docs/a.md · append");
    expect(
      start("edit", { filename: "a.md", edits: [{ oldText: "old", newText: "new" }] }),
    ).toContain("a.md · 1 edit");
    const command = "a".repeat(120);
    expect(start("safeBash", { command, cwd: "project" })).toContain(command);
    expect(
      start("exec", { command: "git", args: ["status", "--short"], cwd: "project" }),
    ).toContain('git "status" "--short"');
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "write", value: true, outcome: "success" },
        plain,
      ),
    ).toContain("Tool finished");
  });

  it.each(["exec", "agencyCli"])("reports nonzero %s exits as failures", (toolName) => {
    const text = formatAgentTrace(
      {
        kind: "toolEnd",
        toolName,
        outcome: "plain",
        value: { stdout: "", stderr: "broken", exitCode: 2 },
      },
      plain,
    );
    expect(text).toContain("✗");
    expect(text).toContain("exit 2");
    expect(text).toContain("broken");
    expect(text).not.toContain("✓");
  });

  it("keeps complete supplied arguments and results in debug output", () => {
    const value = "z".repeat(220);
    const options = { columns: 300, color: false };
    expect(
      formatAgentTrace(
        {
          kind: "toolStart",
          toolName: "read",
          args: { filename: value, offset: 20 },
          detailed: true,
        },
        options,
      ),
    ).toContain('filename: "' + value + '"');
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "read", value, outcome: "success", detailed: true },
        options,
      ),
    ).toContain(value);
    expect(
      formatAgentTrace(
        { kind: "toolEnd", toolName: "custom", value, outcome: "plain", detailed: true },
        options,
      ),
    ).toContain(value);
  });

  it("falls back for malformed arguments and sanitizes compact values", () => {
    expect(start("read", {})).toContain("Tool call  read");
    expect(start("grep", null)).toContain("Tool call  grep");
    const text = formatAgentTrace(
      {
        kind: "toolStart",
        toolName: "read",
        args: { filename: "bad\x1b[2J\nfile.md", offset: 20, limit: 10 },
      },
      { columns: 20, color: false },
    );
    expect(text).not.toContain("\x1b");
    expect(text.split("\n").every((line) => visualWidth(line) <= 20)).toBe(true);
  });
});

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
