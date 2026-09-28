import { describe, it, expect } from "vitest";
import { AgencyFunction } from "./agencyFunction.js";
import {
  computeGateVerdict,
  DEFAULT_MAX_REPEATED_TOOL_CALLS,
  freshRepeatStreak,
  markupArgument,
  noteRepeat,
  refusalMessage,
  repeatKey,
  repeatsBefore,
  resetRepeat,
  runnableHandoffs,
  type GateCall,
  type GateState,
} from "./toolLoopGuards.js";

describe("markupArgument", () => {
  const param = (name: string, hasDefault: boolean) => ({
    name,
    hasDefault,
    defaultValue: undefined,
    variadic: false,
  });
  const execParams = [param("command", false), param("stdin", true)];
  const grepParams = [param("pattern", false), param("flags", true)];

  it("names an optional string argument that is the model's own call markup", () => {
    // The shapes seen in eval statelogs: the closing tag named for the
    // argument, alone or with the next parameter leaking in, and a garbled
    // tag followed by leaked parameter markup.
    expect(markupArgument({ command: "which", stdin: '</antml name="stdin">' }, execParams)).toBe(
      "stdin",
    );
    expect(
      markupArgument(
        { pattern: "import", flags: '</antml name="flags">\n<parameter name="maxResults">50' },
        grepParams,
      ),
    ).toBe("flags");
    expect(
      markupArgument(
        { pattern: "x", flags: '</antmlःparameter>\n<parameter name="maxResults">50' },
        grepParams,
      ),
    ).toBe("flags");
  });

  it("leaves data alone: required parameters, and strings that merely contain such text", () => {
    // A transcript tool given a captured Anthropic reply as its required input.
    expect(markupArgument({ command: '</antml name="stdin"> and more' }, execParams)).toBeNull();
    // An XML tool given parameter markup in the middle of a document.
    expect(
      markupArgument({ pattern: 'a <parameter name="x"> b', flags: "i" }, grepParams),
    ).toBeNull();
    // A closing tag for some OTHER name, with nothing leaked after it, is not this pattern.
    expect(markupArgument({ pattern: "x", flags: "</antml-other>g" }, grepParams)).toBeNull();
    expect(markupArgument({ pattern: "<div>", flags: "" }, grepParams)).toBeNull();
    expect(markupArgument({}, grepParams)).toBeNull();
  });
});

describe("repeated tool calls", () => {
  it("keys a call by tool and arguments, ignoring argument order", () => {
    expect(repeatKey("grep", { pattern: "x", dir: "." })).toBe(
      repeatKey("grep", { dir: ".", pattern: "x" }),
    );
    expect(repeatKey("grep", { pattern: "x" })).not.toBe(repeatKey("grep", { pattern: "y" }));
    expect(repeatKey("grep", { pattern: "x" })).not.toBe(repeatKey("glob", { pattern: "x" }));
  });

  const fresh = freshRepeatStreak;

  it("makes a key that survives JSON storage: the streak rides on the checkpoint, and Postgres jsonb rejects U+0000", () => {
    const key = repeatKey("raiseInterrupt", { a: 1, b: "asdasd" });
    expect(key).not.toMatch(/[\u0000-\u001f]/);
    // The separator also appears in namespaced tool names, so the parts are
    // only unambiguous because the digest is a fixed 64 hex characters.
    expect(repeatKey("std::read", { path: "a" })).not.toBe(repeatKey("std", { path: "a" }));
    expect(repeatKey(`grep:${"0".repeat(64)}`, { pattern: "y" })).not.toBe(
      repeatKey("grep", { pattern: "x" }),
    );
  });

  it("counts identical results in a row and starts over when the result changes", () => {
    const streak = fresh();
    const key = repeatKey("typecheck", { source: "def f() {}" });
    expect(noteRepeat(streak, key, '{"errors":[]}')).toBe(1);
    expect(noteRepeat(streak, key, '{"errors":[]}')).toBe(2);
    expect(noteRepeat(streak, key, '{"errors":[]}')).toBe(3);
    expect(repeatsBefore(streak, key)).toBe(3);
    // The world changed: a new result is a new streak.
    expect(noteRepeat(streak, key, '{"errors":["AG1"]}')).toBe(1);
    expect(noteRepeat(streak, key, '{"errors":[]}')).toBe(1);
  });

  it("any other call in between resets the count", () => {
    // readStatus → advanceJob → readStatus: the poll is not a loop.
    const streak = fresh();
    const poll = repeatKey("readStatus", { id: 1 });
    const advance = repeatKey("advanceJob", { id: 1 });
    for (let i = 0; i < 5; i++) {
      expect(noteRepeat(streak, poll, "pending")).toBe(1);
      expect(noteRepeat(streak, advance, "ok")).toBe(1);
    }
    expect(repeatsBefore(streak, poll)).toBe(0);
  });

  it("a refusal restarts the count, so the call is interrupted, not banned", () => {
    const streak = fresh();
    const poll = repeatKey("readStatus", { id: 1 });
    for (let i = 0; i < 3; i++) noteRepeat(streak, poll, "pending");
    expect(repeatsBefore(streak, poll)).toBe(3);
    resetRepeat(streak);
    expect(repeatsBefore(streak, poll)).toBe(0);
    expect(noteRepeat(streak, poll, "done")).toBe(1);
  });

  it("DEFAULT_MAX_REPEATED_TOOL_CALLS is the documented default", () => {
    expect(DEFAULT_MAX_REPEATED_TOOL_CALLS).toBe(3);
  });
});

describe("computeGateVerdict", () => {
  const tool = (name: string, handoff: boolean) =>
    new AgencyFunction({
      name,
      module: "test.agency",
      fn: async () => "ok",
      params: [],
      toolDefinition: null,
      markers: handoff ? { handoff: true } : {},
    });
  const state = (): GateState => ({
    removedTools: [],
    rejectedCalls: [],
    repeatStreak: freshRepeatStreak(),
    toolCallRound: 0,
    maxToolCallRounds: 10,
    maxRepeatedToolCalls: DEFAULT_MAX_REPEATED_TOOL_CALLS,
  });
  const call = (handler: AgencyFunction, handoffs: string[]): GateCall => ({
    toolCall: { id: "c1", name: handler.name, arguments: {} },
    handler,
    markupArg: null,
    callKey: repeatKey(handler.name, {}),
    runnableHandoffs: handoffs,
  });

  it("lets one handoff through beside ordinary calls", () => {
    const explorer = tool("explorer", true);
    expect(computeGateVerdict(state(), call(explorer, ["explorer"]))).toBe("proceed");
  });

  it("refuses a handoff when the round has two runnable handoffs, and names both", () => {
    const explorer = tool("explorer", true);
    const gateCall = call(explorer, ["explorer", "oracle"]);
    expect(computeGateVerdict(state(), gateCall)).toBe("tooManyHandoffs");
    expect(refusalMessage(state(), "tooManyHandoffs", gateCall)).toContain(
      "explorer and oracle were called in the same response",
    );
  });

  it("does not refuse an ordinary call in a round with two handoffs", () => {
    const lookup = tool("lookup", false);
    expect(computeGateVerdict(state(), call(lookup, ["explorer", "oracle"]))).toBe("proceed");
  });

  it("gives a removed handoff its own refusal, not the handoff one", () => {
    const explorer = tool("explorer", true);
    const removed = { ...state(), removedTools: ["explorer"] };
    expect(computeGateVerdict(removed, call(explorer, ["explorer", "oracle"]))).toBe("removed");
  });
});

describe("runnableHandoffs", () => {
  const tool = (name: string, handoff: boolean) =>
    new AgencyFunction({
      name,
      module: "test.agency",
      fn: async () => "ok",
      params: [],
      toolDefinition: null,
      markers: handoff ? { handoff: true } : {},
    });
  const input = (handler: AgencyFunction) => ({
    toolCall: { id: handler.name, name: handler.name, arguments: {} },
    handler,
    markupArg: null,
    callKey: repeatKey(handler.name, {}),
  });
  const state = (removedTools: string[]): GateState => ({
    removedTools,
    rejectedCalls: [],
    repeatStreak: freshRepeatStreak(),
    toolCallRound: 0,
    maxToolCallRounds: 10,
    maxRepeatedToolCalls: DEFAULT_MAX_REPEATED_TOOL_CALLS,
  });
  const inputs = [
    input(tool("explorer", true)),
    input(tool("oracle", true)),
    input(tool("lookup", false)),
  ];

  it("lists the handoff calls and leaves out ordinary calls", () => {
    expect(runnableHandoffs(state([]), inputs)).toEqual(["explorer", "oracle"]);
  });

  it("leaves out a handoff that another check refuses", () => {
    // The model called a removed handoff beside a live one. The live one
    // is the only handoff that could run, so it must not be refused.
    expect(runnableHandoffs(state(["explorer"]), inputs)).toEqual(["oracle"]);
  });
});
