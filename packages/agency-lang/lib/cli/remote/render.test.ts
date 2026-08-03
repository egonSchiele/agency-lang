import { describe, it, expect } from "vitest";
import { renderManifest, renderResult, renderLink } from "./render.js";

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
