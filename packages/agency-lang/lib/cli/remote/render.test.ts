import { describe, it, expect } from "vitest";
import {
  renderManifest,
  renderResult,
  renderLink,
  renderWhoami,
  renderProjects,
  renderProjectCreated,
  renderKeys,
  renderCreatedKey,
  renderTraceList,
  renderPullSummary,
  renderProjectSpend,
  renderAccountSpend,
} from "./render.js";
import type { CreatedKey, KeySummary } from "../statelog/accountClient.js";
import type { ProjectSpend, AccountSpendRow } from "../statelog/spendTypes.js";

// Colour wraps each token in ANSI codes; strip them so assertions read plainly.
// eslint-disable-next-line no-control-regex
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const binding = {
  serveUrl: "https://h/serve/u/proj/agent.agency",
  origin: "https://h",
  userId: "u",
  projectId: "proj",
  filename: "agent.agency",
};

describe("renderManifest", () => {
  const manifest = {
    nodes: [{ name: "main", parameters: ["message"], interruptEffects: ["app::confirm"] }],
    functions: [
      { name: "add", parameters: ["a", "b"], interruptEffects: [], description: "adds two numbers" },
    ],
  };

  it("lists nodes and functions with their params, effects, and description", () => {
    const output = strip(renderManifest(manifest, binding));
    expect(output).toContain("agent.agency");
    expect(output).toContain("main(message)");
    expect(output).toContain("raises app::confirm");
    expect(output).toContain("add(a, b)");
    expect(output).toContain("adds two numbers");
  });
});

describe("renderResult", () => {
  it("prints a string value verbatim and pretty-prints objects", () => {
    expect(strip(renderResult("done"))).toContain("done");
    expect(strip(renderResult({ a: 1 }))).toContain(`"a": 1`);
  });
});

describe("renderLink", () => {
  it("shows the agent, project, and serve URL", () => {
    const output = strip(renderLink(binding));
    expect(output).toContain("agent.agency");
    expect(output).toContain("proj");
    expect(output).toContain("https://h/serve/u/proj/agent.agency");
  });
});

// Column start positions on a stripped line: index 0 and the char after any run
// of 2+ spaces. Single spaces inside a cell (e.g. "Public Project") don't split.
function colStarts(line: string): number[] {
  const starts: number[] = [];
  const re = /(?:^|\s{2,})(\S)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    starts.push(match.index + match[0].length - 1);
  }
  return starts;
}

describe("renderWhoami", () => {
  it("shows the user id and host", () => {
    const out = strip(renderWhoami("user-1", "https://host.example"));
    expect(out).toContain("user-1");
    expect(out).toContain("https://host.example");
  });
});

describe("renderProjects", () => {
  it("shows an empty-state line", () => {
    expect(strip(renderProjects([]))).toContain("No projects yet.");
  });

  it("renders aligned rows with — for a null description", () => {
    const out = strip(
      renderProjects([
        { projectId: "public-project", name: "Public Project", description: null },
        { projectId: "p2", name: "Second", description: "has a desc" },
      ]),
    );
    const lines = out.split("\n");
    expect(lines[1]).toContain("public-project");
    expect(lines[1]).toContain("—");
    for (const line of lines) {
      expect(colStarts(line)).toEqual(colStarts(lines[0] ?? ""));
    }
  });
});

describe("renderProjectCreated", () => {
  it("shows the slug and name", () => {
    const out = strip(renderProjectCreated({ projectId: "my-proj", name: "My Project", description: null }));
    expect(out).toContain("my-proj");
    expect(out).toContain("My Project");
  });
});

describe("renderKeys", () => {
  const keys: KeySummary[] = [
    { id: "k1", name: null, scope: "project", projectId: "(unknown project)", createdAt: "2026-08-03" },
    { id: "k2", name: "root", scope: "account", projectId: null, createdAt: "2026-08-03" },
  ];

  it("shows an empty-state line", () => {
    expect(strip(renderKeys([]))).toContain("No API keys yet.");
  });

  it("renders — for a null name, the placeholder slug, and aligned columns", () => {
    const out = strip(renderKeys(keys));
    const lines = out.split("\n");
    expect(lines[1]).toContain("—");
    expect(lines[1]).toContain("(unknown project)");
    expect(out).toContain("account");
    for (const line of lines) {
      expect(colStarts(line)).toEqual(colStarts(lines[0] ?? ""));
    }
  });
});

describe("renderCreatedKey", () => {
  const createdKey: CreatedKey = {
    id: "k1",
    name: "CI",
    scope: "project",
    projectId: "my-proj",
    createdAt: "2026-08-03",
    plainKey: "plain-once",
  };

  it("shows the plaintext key exactly once with a one-time warning", () => {
    const output = strip(renderCreatedKey(createdKey));
    expect(output.match(/plain-once/g)).toHaveLength(1);
    expect(output).toContain("will not be shown again");
  });

  it("never leaks the plaintext key into the list view", () => {
    expect(strip(renderKeys([createdKey]))).not.toContain("plain-once");
  });
});

describe("renderTraceList", () => {
  it("renders aligned rows and an empty state", () => {
    expect(strip(renderTraceList([]))).toContain("No traces yet.");
    const out = strip(
      renderTraceList([
        { id: "trace-b", createdAt: "2026-08-03T02:00:00Z" },
        { id: "trace-a", createdAt: "2026-08-03T01:00:00Z" },
      ]),
    );
    expect(out).toContain("trace-b");
    expect(out).toContain("trace-a");
  });
});

describe("renderPullSummary", () => {
  it("lists the written files under the output directory", () => {
    const out = strip(renderPullSummary(["main.agency", "helper.agency"], "/out"));
    expect(out).toContain("Pulled 2 files to /out");
    expect(out).toContain("main.agency");
    expect(out).toContain("helper.agency");
  });
});

const spend = (overrides: Partial<ProjectSpend> = {}): ProjectSpend => ({
  pricedCost: 0.4212, inputTokens: 12400, outputTokens: 3010, invocationCount: 87, unpricedCallCount: 0, pricingComplete: true, usageComplete: true, ...overrides,
});

describe("renderProjectSpend", () => {
  it("shows cost, tokens, invocations, and the window label; no lower-bound/unpriced lines when complete", () => {
    const out = strip(renderProjectSpend("my-agent", spend(), "last 7d"));
    expect(out).toContain("Spend: my-agent");
    expect(out).toContain("(last 7d)");
    expect(out).toContain("$0.4212");
    expect(out).toContain("↑ 12,400");
    expect(out).toContain("↓ 3,010");
    expect(out).toContain("Invocations:  87");
    expect(out).not.toContain("lower bound");
    expect(out).not.toContain("unpriced");
  });
  it("marks a lower bound when usage is incomplete", () => {
    const out = strip(renderProjectSpend("a", spend({ usageComplete: false }), "all time"));
    expect(out).toContain("≥ $0.4212");
    expect(out).toContain("lower bound");
  });
  it("notes unpriced calls", () => {
    const out = strip(renderProjectSpend("a", spend({ unpricedCallCount: 2, pricingComplete: false }), "all time"));
    expect(out).toContain("2 unpriced call(s)");
  });
  it("shows $0.0000 for true zero and <$0.0001 for a tiny positive", () => {
    expect(strip(renderProjectSpend("a", spend({ pricedCost: 0 }), "all time"))).toContain("$0.0000");
    expect(strip(renderProjectSpend("a", spend({ pricedCost: 0.00004 }), "all time"))).toContain("<$0.0001");
  });
});

const row = (slug: string, pricedCost: number, over: Partial<ProjectSpend> = {}, deletedAt: string | null = null): AccountSpendRow => ({
  projectSlug: slug, deletedAt, spend: spend({ pricedCost, ...over }),
});

describe("renderAccountSpend", () => {
  it("empty → no projects", () => {
    expect(strip(renderAccountSpend([], "all time"))).toBe("No projects yet.");
  });
  it("sorts active by cost desc then deleted, with slug tie-break, and totals correctly", () => {
    const out = strip(renderAccountSpend([
      row("b-cheap", 0.10),
      row("gone", 0.99, {}, "2026-08-01T00:00:00.000Z"),
      row("a-tie", 0.50),
      row("b-tie", 0.50),
    ], "last 7d"));
    const lines = out.split("\n");
    const order = lines.filter((l) => /a-tie|b-tie|b-cheap|gone|TOTAL/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
    expect(order).toEqual(["a-tie", "b-tie", "b-cheap", "gone", "TOTAL"]);
    expect(out).toContain("PROJECT");
    expect(out).toContain("UNPRICED");
    expect(out).toContain("$2.0900"); // 0.10+0.99+0.50+0.50, all complete
    expect(out).toContain("gone (deleted)");
  });
  it("degrades the TOTAL when a single row is incomplete or unpriced", () => {
    const out = strip(renderAccountSpend([
      row("ok", 1),
      row("bad", 2, { usageComplete: false, unpricedCallCount: 3, pricingComplete: false }),
    ], "all time"));
    const total = out.split("\n").find((l) => l.includes("TOTAL")) ?? "";
    expect(total).toContain("≥ $3.0000");
    expect(out).toContain("incomplete telemetry");
    expect(out).toContain("3 unpriced call(s) total");
  });
});
