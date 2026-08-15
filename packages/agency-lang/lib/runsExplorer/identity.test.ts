import { describe, expect, it } from "vitest";

import { agentColors, resolveAgentName, shortAgentLabel } from "./identity.js";

describe("resolveAgentName", () => {
  it("prefers the statelog agentName over everything", () => {
    expect(
      resolveAgentName({
        agentName: "gcode-v2",
        agentLabel: "/abs/agent.agency:main",
        command: "claude -p {task}",
        fallback: "run-1",
      }),
    ).toBe("gcode-v2");
  });

  it("falls back through label, then command, then the fallback", () => {
    expect(resolveAgentName({ agentLabel: "/abs/regex.agency:main", fallback: "f" })).toBe(
      "regex.agency",
    );
    expect(
      resolveAgentName({ command: "node ./agency.js agent --agent gcode", fallback: "f" }),
    ).toBe("agency-agent(gcode)");
    expect(resolveAgentName({ fallback: "log.jsonl#a41f2c" })).toBe("log.jsonl#a41f2c");
  });
});

describe("shortAgentLabel", () => {
  it("shortens agency agent commands to agency-agent(name)", () => {
    expect(shortAgentLabel("node ./dist/scripts/agency.js agent --agent gcode --policy x")).toBe(
      "agency-agent(gcode)",
    );
    expect(shortAgentLabel("agency agent")).toBe("agency-agent");
  });

  it("keeps the basename of .agency entries", () => {
    expect(shortAgentLabel("/Users/someone/very/long/path/regex.agency:main")).toBe("regex.agency");
  });

  it("clips other labels at the named maximum with an ellipsis", () => {
    const long = "claude --dangerously-skip-permissions -p {task} --output json";
    const short = shortAgentLabel(long);
    expect(short.length).toBeLessThanOrEqual(24);
    expect(short.endsWith("…")).toBe(true);
  });
});

describe("agentColors", () => {
  it("assigns the palette by frequency rank, deterministically", () => {
    const names = ["b", "a", "a", "a", "b", "b", "b", "c"];
    const colors = agentColors(names);
    expect(colors["b"]).toBe("bright-cyan");
    expect(colors["a"]).toBe("bright-magenta");
    expect(colors["c"]).toBe("bright-yellow");
  });

  it("names beyond the palette get no color", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const colors = agentColors(names);
    expect(colors["i"]).toBeUndefined();
  });
});
