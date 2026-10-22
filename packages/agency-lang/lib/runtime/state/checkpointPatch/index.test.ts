import { describe, expect, it } from "vitest";
import { fromOverrides, patchCheckpoint } from "./index.js";
import { agentShapedCheckpoint, ROOT, TOOL } from "./testCheckpoints.js";
import { signCheckpoint, verifyCheckpointChecksum } from "../../checkpointChecksum.js";
import type { HostSettings } from "../../../host/host.js";
import { getAt } from "./jsonPath.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef";
const signing: HostSettings = {
  read: (name) => (name === "AGENCY_CHECKPOINT_KEY" ? KEY : null),
  log: () => {},
};
const unsigned: HostSettings = { read: () => null, log: () => {} };

describe("patchCheckpoint", () => {
  it("applies every edit in order and leaves the source alone", () => {
    const source = agentShapedCheckpoint();
    const before = JSON.stringify(source.toJSON());
    const result = patchCheckpoint(
      source,
      [
        { op: "setLocal", name: "answer", value: "x" },
        { op: "appendMessage", text: "stop" },
      ],
      unsigned,
    );
    expect("refused" in result).toBe(false);
    if ("refused" in result) return;
    const json = result.checkpoint.toJSON();
    expect(getAt(json, [...ROOT, "0", "locals", "answer"])).toBe("x");
    expect(getAt(json, [...ROOT, "1", "locals", "messagesJSON", "queuedMessages"])).toEqual([
      { role: "user", content: "stop", label: null },
    ]);
    expect(result.applied).toEqual([
      'answer = "x"',
      "queued on thread main, delivered after 1 pending tool result",
    ]);
    expect(JSON.stringify(source.toJSON())).toBe(before);
    expect(result.checkpoint.signature).toBeUndefined();
  });

  it("two edits on one place add up: each is lowered against the edits before it", () => {
    const source = agentShapedCheckpoint();
    const result = patchCheckpoint(
      source,
      [
        { op: "appendMessage", text: "A" },
        { op: "appendMessage", text: "B" },
        { op: "removeTool", tool: "search" },
        { op: "removeTool", tool: "writeUp" },
      ],
      unsigned,
    );
    if ("refused" in result) throw new Error(result.refused.join());
    const json = result.checkpoint.toJSON();
    expect(getAt(json, [...ROOT, "1", "locals", "messagesJSON", "queuedMessages"])).toEqual([
      { role: "user", content: "A", label: null },
      { role: "user", content: "B", label: null },
    ]);
    expect(getAt(json, [...ROOT, "1", "locals", "removedTools"])).toEqual(["search", "writeUp"]);
    expect(result.applied).toHaveLength(4);
  });

  it("an edit that is not one of the schema's shapes is refused, not thrown", () => {
    const source = agentShapedCheckpoint();
    const bogus = [
      { op: "bogus" },
      { op: "setLocal", name: "constructor", value: {} },
    ] as unknown as Parameters<typeof patchCheckpoint>[1];
    const result = patchCheckpoint(source, bogus, unsigned);
    expect("refused" in result).toBe(true);
    if (!("refused" in result)) return;
    expect(result.refused).toHaveLength(2);
    expect(result.refused[0]).toMatch(/^edit 0 at op: /);
    expect(result.refused[1]).toBe("edit 1 at name: not a prototype key");
    expect(Object.hasOwn(source.stack.stack[0].locals, "constructor")).toBe(false);
  });

  it("no edits is a signed copy and nothing else", () => {
    const source = agentShapedCheckpoint();
    signCheckpoint(source, signing);
    const result = patchCheckpoint(source, [], signing);
    if ("refused" in result) throw new Error(result.refused.join());
    expect(result.applied).toEqual([]);
    expect(result.checkpoint).not.toBe(source);
    expect(result.checkpoint.toJSON()).toEqual(source.toJSON());
    expect(verifyCheckpointChecksum(result.checkpoint, signing)).toBe(true);
  });

  it("a signed source comes back signed under the settings; an unsigned one stays unsigned", () => {
    const source = agentShapedCheckpoint();
    signCheckpoint(source, signing);
    expect(source.signature).toBeDefined();
    const result = patchCheckpoint(source, [{ op: "setLocal", name: "answer", value: 1 }], signing);
    if ("refused" in result) throw new Error(result.refused.join());
    expect(result.checkpoint.signature).not.toBe(source.signature);
    expect(verifyCheckpointChecksum(result.checkpoint, signing)).toBe(true);
  });

  it("refuses the lot when any edit is refused, naming each reason", () => {
    const source = agentShapedCheckpoint();
    const result = patchCheckpoint(
      source,
      [
        { op: "setLocal", name: "answer", value: "x" },
        { op: "removeTool", tool: "nope" },
        { op: "setLocal", frame: { scope: "runPrompt" }, name: "toolCallRound", value: 9 },
      ],
      unsigned,
    );
    expect(result).toEqual({
      refused: [
        "no tool nope in this loop (search, writeUp)",
        `${[...ROOT, "1", "locals", "toolCallRound"].join(".")} is a control field; see the field-kind table`,
      ],
    });
  });

  it("refuses a result that breaks an invariant the source kept", () => {
    const source = agentShapedCheckpoint();
    const result = patchCheckpoint(
      source,
      [{ op: "setGuard", guard: { label: "research" }, limit: 5000 }],
      unsigned,
    );
    expect(result).toEqual({
      refused: ["guard over its limit: research would trip at once (10000 of 5000)"],
    });
  });

  it("an edit with its own stop lands on that stop's frame", () => {
    const source = agentShapedCheckpoint();
    const result = patchCheckpoint(
      source,
      [{ op: "setLocal", name: "url", value: "v" }],
      unsigned,
      {
        branchPath: ["tool_0_abc"],
        loopStop: "round",
      },
    );
    if ("refused" in result) throw new Error(result.refused.join());
    expect(getAt(result.checkpoint.toJSON(), [...TOOL, "0", "locals", "url"])).toBe("v");
  });
});

describe("fromOverrides", () => {
  it("maps the three override shapes to edits on the checkpoint's own frame", () => {
    const cp = agentShapedCheckpoint();
    expect(
      fromOverrides({ locals: { mood: "happy" }, args: { n: 1 }, globals: { g: true } }, cp),
    ).toEqual([
      { op: "setLocal", frame: { branchPath: [] }, name: "mood", value: "happy" },
      { op: "setArg", frame: { branchPath: [] }, name: "n", value: 1 },
      { op: "setGlobal", branchPath: [], name: "g", value: true },
    ]);
    expect(fromOverrides({}, cp)).toEqual([]);
    expect(
      fromOverrides({ locals: { x: 1 } }, cp, { branchPath: ["tool_0_abc"], loopStop: undefined }),
    ).toEqual([{ op: "setLocal", frame: { branchPath: ["tool_0_abc"] }, name: "x", value: 1 }]);
  });

  it("refuses a prototype key as the resume overrides did", () => {
    const cp = agentShapedCheckpoint();
    const overrides = JSON.parse('{"locals":{"__proto__":{"polluted":true}}}');
    expect(() => fromOverrides(overrides, cp)).toThrow("invalid override name");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
