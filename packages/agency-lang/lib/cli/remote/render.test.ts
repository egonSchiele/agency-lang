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
      {
        name: "add",
        parameters: ["a", "b"],
        interruptEffects: [],
        description: "adds two numbers",
      },
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
    const out = strip(
      renderProjectCreated({ projectId: "my-proj", name: "My Project", description: null }),
    );
    expect(out).toContain("my-proj");
    expect(out).toContain("My Project");
  });
});

describe("renderKeys", () => {
  const keys: KeySummary[] = [
    {
      id: "k1",
      name: null,
      scope: "project",
      projectId: "(unknown project)",
      createdAt: "2026-08-03",
    },
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

function usd(totalCost: number) {
  return {
    inputCost: totalCost,
    outputCost: 0,
    cachedInputCost: 0,
    cacheCreationInputCost: 0,
    hostedToolsCost: 0,
    totalCost,
    currency: "USD" as const,
  };
}
function toks(input: number, output: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: input + output,
  };
}
const NONE_GROUP = { byModel: false, byKind: false };

const spend = (overrides: Partial<ProjectSpend> = {}): ProjectSpend => ({
  cost: usd(0.4212),
  tokens: toks(12400, 3010),
  invocationCount: 87,
  unpricedCallCount: 0,
  pricingComplete: true,
  usageComplete: true,
  breakdown: [],
  breakdownTruncated: false,
  otherSpend: {
    cost: {
      inputCost: 0,
      outputCost: 0,
      cachedInputCost: 0,
      cacheCreationInputCost: 0,
      hostedToolsCost: 0,
      totalCost: 0,
      currency: "USD",
    },
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
    },
  },
  ...overrides,
});

describe("renderProjectSpend", () => {
  it("shows cost, token components/total, invocations, and the window label; no notes when complete", () => {
    const out = strip(renderProjectSpend("my-agent", spend(), "last 7d", NONE_GROUP));
    expect(out).toContain("Spend: my-agent");
    expect(out).toContain("(last 7d)");
    expect(out).toContain("$0.4212");
    expect(out).toContain("12,400"); // input-token component
    expect(out).toContain("3,010"); // output-token component
    expect(out).toContain("15,410 total"); // authoritative total tokens
    expect(out).toContain("Invocations:  87");
    expect(out).not.toContain("lower bound");
    expect(out).not.toContain("unpriced");
  });
  it("prints No spend for a zero-invocation project", () => {
    expect(
      strip(
        renderProjectSpend(
          "a",
          spend({ invocationCount: 0, cost: usd(0), tokens: toks(0, 0) }),
          "last 7d",
          NONE_GROUP,
        ),
      ),
    ).toBe("No spend in last 7d.");
  });
  it("marks a lower bound when usage is incomplete", () => {
    const out = strip(
      renderProjectSpend("a", spend({ usageComplete: false }), "all time", NONE_GROUP),
    );
    expect(out).toContain("≥ $0.4212");
    expect(out).toContain("lower bound");
  });
  it("marks a lower bound when a call was unpriced, and notes it separately", () => {
    const out = strip(
      renderProjectSpend(
        "a",
        spend({ unpricedCallCount: 2, pricingComplete: false }),
        "all time",
        NONE_GROUP,
      ),
    );
    expect(out).toContain("≥ $0.4212");
    expect(out).toContain("2 unpriced call(s)");
    expect(out).not.toContain("lower bound"); // telemetry note only fires on !usageComplete
  });
  it("shows $0.0000 for true zero and <$0.0001 for a tiny positive", () => {
    expect(
      strip(renderProjectSpend("a", spend({ cost: usd(0) }), "all time", NONE_GROUP)),
    ).toContain("$0.0000");
    expect(
      strip(renderProjectSpend("a", spend({ cost: usd(0.00004) }), "all time", NONE_GROUP)),
    ).toContain("<$0.0001");
  });
  it("keeps a tiny positive lower bound visible (neither '≥ <$0.0001' nor a floored '≥ $0.0000')", () => {
    const out = strip(
      renderProjectSpend(
        "a",
        spend({ cost: usd(0.00004), usageComplete: false }),
        "all time",
        NONE_GROUP,
      ),
    );
    const costLine = out.split("\n").find((l) => l.includes("Cost:")) ?? "";
    expect(costLine).not.toContain("≥ <");
    expect(costLine).toContain("≥ $0.00004");
    // Must NOT floor a known positive amount to zero.
    expect(costLine).not.toMatch(/≥ \$0\.0000(?!\d)/);
  });
  it("keeps a positive lower bound below 1e-8 visible via scientific notation", () => {
    const out = strip(
      renderProjectSpend(
        "a",
        spend({ cost: usd(1e-10), usageComplete: false }),
        "all time",
        NONE_GROUP,
      ),
    );
    const costLine = out.split("\n").find((l) => l.includes("Cost:")) ?? "";
    expect(costLine).toContain("≥ $");
    expect(costLine).toMatch(/e-\d+/); // scientific notation, not a floored $0
    expect(costLine).not.toMatch(/≥ \$0\b/);
  });
  it("groups the breakdown by model, sorts by cost desc, and labels the manual sentinel", () => {
    const breakdown = [
      { model: "opus", kind: "completion" as const, cost: usd(0.1), tokens: toks(10, 2) },
      { model: "", kind: "manual" as const, cost: usd(0.9), tokens: toks(0, 0) },
    ];
    const out = strip(
      renderProjectSpend("a", spend({ breakdown }), "all time", { byModel: true, byKind: false }),
    );
    expect(out).toContain("MODEL");
    expect(out).toContain("(manual)");
    const bodyLines = out.split("\n").filter((l) => /opus|\(manual\)/.test(l));
    // (manual) at $0.9000 sorts above opus at $0.1000.
    expect(bodyLines[0]).toContain("(manual)");
    expect(bodyLines[1]).toContain("opus");
  });
  it("aggregates grouped breakdown token counters as bigint across the safe-integer boundary", () => {
    const big = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991
    const breakdown = [
      {
        model: "opus",
        kind: "completion" as const,
        cost: usd(0.1),
        tokens: {
          inputTokens: big,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: big,
        },
      },
      {
        model: "sonnet",
        kind: "completion" as const,
        cost: usd(0.2),
        tokens: {
          inputTokens: 2,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 2,
        },
      },
    ];
    // Grouped by kind → both models collapse into one "completion" group.
    const out = strip(
      renderProjectSpend("a", spend({ breakdown }), "all time", { byModel: false, byKind: true }),
    );
    expect(out).toContain("9,007,199,254,740,993");
    expect(out).not.toContain("9,007,199,254,740,992");
  });

  it("groups by kind when only --by-kind is set", () => {
    const breakdown = [
      { model: "opus", kind: "completion" as const, cost: usd(0.1), tokens: toks(10, 2) },
      { model: "ada", kind: "embedding" as const, cost: usd(0.2), tokens: toks(5, 0) },
    ];
    const out = strip(
      renderProjectSpend("a", spend({ breakdown }), "all time", { byModel: false, byKind: true }),
    );
    expect(out).toContain("KIND");
    expect(out).toContain("embedding");
    expect(out).toContain("completion");
    expect(out).not.toContain("MODEL");
  });
  it("notes the omitted tail when the breakdown is truncated", () => {
    const breakdown = [
      { model: "opus", kind: "completion" as const, cost: usd(1), tokens: toks(10, 2) },
    ];
    const out = strip(
      renderProjectSpend(
        "a",
        spend({
          breakdown,
          breakdownTruncated: true,
          otherSpend: { cost: usd(3), tokens: toks(5, 5) },
        }),
        "all time",
        { byModel: true, byKind: false },
      ),
    );
    expect(out).toContain("more across other groups");
    expect(out).toContain("$3.0000");
  });
  it("shows no truncation note when the breakdown is complete", () => {
    const breakdown = [
      { model: "opus", kind: "completion" as const, cost: usd(1), tokens: toks(10, 2) },
    ];
    const out = strip(
      renderProjectSpend("a", spend({ breakdown }), "all time", { byModel: true, byKind: false }),
    );
    expect(out).not.toContain("more across other groups");
  });
});

const row = (
  slug: string,
  pricedCost: number,
  over: Partial<ProjectSpend> = {},
  deletedAt: string | null = null,
): AccountSpendRow => ({
  projectSlug: slug,
  deletedAt,
  spend: spend({ cost: usd(pricedCost), ...over }),
});

describe("renderAccountSpend", () => {
  it("empty → no projects", () => {
    expect(strip(renderAccountSpend([], "all time"))).toBe("No projects yet.");
  });
  it("sorts active by cost desc then deleted, with slug tie-break, and totals correctly", () => {
    const out = strip(
      renderAccountSpend(
        [
          row("b-cheap", 0.1),
          row("gone", 0.99, {}, "2026-08-01T00:00:00.000Z"),
          row("a-tie", 0.5),
          row("b-tie", 0.5),
        ],
        "last 7d",
      ),
    );
    const lines = out.split("\n");
    const order = lines
      .filter((l) => /a-tie|b-tie|b-cheap|gone|TOTAL/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]);
    expect(order).toEqual(["a-tie", "b-tie", "b-cheap", "gone", "TOTAL"]);
    expect(out).toContain("PROJECT");
    expect(out).toContain("UNPRICED");
    expect(out).toContain("$2.0900"); // 0.10+0.99+0.50+0.50, all complete
    expect(out).toContain("gone (deleted)");
  });
  it("degrades the TOTAL cost AND token columns when a single row is incomplete or unpriced", () => {
    const out = strip(
      renderAccountSpend(
        [
          row("ok", 1),
          row("bad", 2, {
            usageComplete: false,
            unpricedCallCount: 3,
            pricingComplete: false,
            tokens: toks(999, 111),
          }),
        ],
        "all time",
      ),
    );
    const total = out.split("\n").find((l) => l.includes("TOTAL")) ?? "";
    const badRow = out.split("\n").find((l) => l.includes("bad")) ?? "";
    expect(total).toContain("≥ $3.0000");
    // Tokens are a lower bound too when telemetry is incomplete — cost is not the
    // only degraded column.
    expect(badRow).toContain("≥ 999");
    expect(total).toContain("≥ ");
    expect(out).toContain("incomplete telemetry");
    expect(out).toContain("3 unpriced call(s) total");
  });

  it("sums token counts as bigint so a TOTAL crossing MAX_SAFE_INTEGER stays exact", () => {
    const big = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991
    const out = strip(
      renderAccountSpend(
        [
          row("a", 1, {
            tokens: {
              inputTokens: big,
              outputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              totalTokens: big,
            },
          }),
          row("b", 1, {
            tokens: {
              inputTokens: 2,
              outputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              totalTokens: 2,
            },
          }),
        ],
        "all time",
      ),
    );
    const total = out.split("\n").find((l) => l.includes("TOTAL")) ?? "";
    // big + 2 = 9,007,199,254,740,993 exactly; Number addition rounds to ...992.
    expect(total).toContain("9,007,199,254,740,993");
    expect(total).not.toContain("9,007,199,254,740,992");
  });

  it("does NOT mark token columns as lower bounds for an unpriced-but-complete row", () => {
    // Unpriced affects cost, not token counts: the token column stays exact.
    const out = strip(
      renderAccountSpend(
        [
          row("only-unpriced", 1, {
            usageComplete: true,
            unpricedCallCount: 2,
            pricingComplete: false,
            tokens: toks(500, 50),
          }),
        ],
        "all time",
      ),
    );
    const dataRow = out.split("\n").find((l) => l.includes("only-unpriced")) ?? "";
    expect(dataRow).toContain("500"); // exact, no ≥
    expect(dataRow).not.toMatch(/≥ 500/);
  });
});
