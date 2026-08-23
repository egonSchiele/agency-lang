import { describe, expect, it } from "vitest";

import { AGENT_NAME_MAX_LENGTH, agentNameProblem } from "./agentName.js";

/** The statelog batch page's path for an agent, built the way the CLI and
 *  the web app build it. */
function batchPath(agent: string): string {
  return new URL(
    `/projects/p/evals/agents/${encodeURIComponent(agent)}/batches/b`,
    "https://statelog.example",
  ).pathname;
}

describe("agentNameProblem", () => {
  it("accepts names made of letters, digits, dots, underscores, dashes, and slash-separated segments", () => {
    for (const name of ["agency-agent/coordinator", "gcode.v2_1", "a", "x".repeat(AGENT_NAME_MAX_LENGTH)]) {
      expect(agentNameProblem(name), name).toBeNull();
      // The name is one route parameter, unchanged by URL parsing.
      expect(batchPath(name)).toBe(`/projects/p/evals/agents/${encodeURIComponent(name)}/batches/b`);
    }
  });

  it("rejects whitespace, other punctuation, and overlong names", () => {
    expect(agentNameProblem("")).toMatch(/must not be empty/);
    expect(agentNameProblem("gcode v2")).toMatch(/letters, digits/);
    expect(agentNameProblem("agent\n")).toMatch(/letters, digits/);
    expect(agentNameProblem("agent ")).toMatch(/letters, digits/);
    expect(agentNameProblem("a:b")).toMatch(/letters, digits/);
    expect(agentNameProblem("x".repeat(AGENT_NAME_MAX_LENGTH + 1))).toMatch(/at most 200/);
  });

  it("rejects dot segments and empty segments, which a URL would fold away", () => {
    for (const name of [".", "..", "a/./b", "a/../b"]) {
      expect(agentNameProblem(name), name).toMatch(/no "\." or "\.\." segment/);
    }
    for (const name of ["/a", "a/", "a//b"]) {
      expect(agentNameProblem(name), name).toMatch(/no empty "\/" segment/);
    }
    // Why: even encoded, `..` is normalized out of the path.
    expect(batchPath("..")).toBe("/projects/p/evals/batches/b");
  });
});
