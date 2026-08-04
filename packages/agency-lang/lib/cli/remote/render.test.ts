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
  renderAgent,
  renderTraceList,
  renderPullSummary,
} from "./render.js";
import type { CreatedKey, KeySummary } from "../statelog/accountClient.js";
import type { AgentMetadata } from "../statelog/projectClient.js";

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

describe("renderAgent", () => {
  const agent: AgentMetadata = {
    entryPoint: "main.agency",
    lastUploadAt: "2026-08-03T00:00:00Z",
    files: [
      { name: "main.agency", nodeNames: ["main", "step2"], createdAt: "t", updatedAt: "t" },
      { name: "helper.agency", nodeNames: [], createdAt: "t", updatedAt: "t" },
    ],
  };

  it("shows entry point, last upload, node names, and the ls hint", () => {
    const out = strip(renderAgent(agent));
    expect(out).toContain("main.agency");
    expect(out).toContain("2026-08-03T00:00:00Z");
    expect(out).toContain("main, step2");
    expect(out).toContain("—"); // helper.agency has no nodes
    expect(out).toContain("remote ls");
    expect(out).toContain("exported nodes");
  });

  it("handles a null entry point and no files", () => {
    const out = strip(renderAgent({ entryPoint: null, lastUploadAt: null, files: [] }));
    expect(out).toContain("No files deployed.");
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
