import {
  handoffEndsTurn,
  resultUnwrapped,
  jsonReplaced,
  toolEndsTurn,
  silentEnderFallsBack,
  viaHelperEnds,
  beside,
  ordinaryBesideHandoff,
  twoMarks,
  customMessageSuccess,
  customMessageFailure,
  rejectedKeepsText,
  emptyMessageIgnored,
  ordinaryMessengerIgnored,
  endsThenFailsNode,
  structuredMatch,
  structuredMismatch,
  nonStringFallback,
  attachmentFallback,
  attachmentAlone,
  resumeEndsTurn,
  resumeNestedEndsTurn,
  nested,
  nestedTurn,
  parallelEndsTurn,
  asyncNestedTurn,
  calledFromCode,
  respondToInterrupts,
  approve,
  reject,
  __setLLMClient,
} from "./agent.js";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// Record every request the model sees, in order, plus the tools that
// started. A scenario that ends the turn makes no follow-up request, so
// its last request is the body's, or the caller's first.
const makeCapture = () => {
  const state = { requests: [], toolStarts: [] };
  const callbacks = {
    onLLMCallStart: ({ messages }) => {
      state.requests.push(messages);
    },
    onToolCallStart: ({ toolName }) => {
      state.toolStarts.push(toolName);
    },
  };
  return { state, callbacks };
};

const text = (message) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);
const roles = (messages) => messages.map((message) => message.role);
const last = (state) => state.requests[state.requests.length - 1];
const lastText = (messages) => text(messages[messages.length - 1]);
const count = (messages, needle) =>
  messages.filter((message) => text(message).includes(needle)).length;
const hasToolCalls = (message) => Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
const toolTexts = (messages) =>
  messages
    .filter((message) => message.role === "tool")
    .map(text)
    .sort();
const carriesImage = (messages) =>
  messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === "image"),
  );

// Would a real provider accept this request? Every assistant message that
// carries N tool calls is followed by exactly N tool messages, tool
// messages appear nowhere else, a request never ends on an assistant
// message, and no two assistant messages are adjacent (the Anthropic
// client would merge them, and the answer would read as JSON then prose).
const wellFormed = (messages) => {
  let owed = 0;
  let previousRole = null;
  for (const message of messages) {
    if (message.role === "assistant" && previousRole === "assistant") {
      return false;
    }
    previousRole = message.role;
    if (message.role === "tool") {
      if (owed === 0) {
        return false;
      }
      owed -= 1;
      continue;
    }
    if (owed > 0) {
      return false;
    }
    if (message.role === "assistant" && hasToolCalls(message)) {
      owed = message.toolCalls.length;
    }
  }
  return owed === 0 && messages[messages.length - 1]?.role !== "assistant";
};
const allWellFormed = (state) => state.requests.every(wellFormed);

// The statelog file holds the endTurn warnings. Each scenario reads the
// entries written since it started.
const LOG = "statelog.log";
if (existsSync(LOG)) {
  unlinkSync(LOG);
}
const logLines = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8").split("\n") : []);
const logMark = () => logLines().length;
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};
// Each line wraps the event under `data`.
const eventsSince = (mark) =>
  logLines()
    .slice(mark)
    .map(parse)
    .map((line) => line?.data)
    .filter((event) => event !== undefined && event !== null);
const warningsSince = (mark) =>
  eventsSince(mark)
    .filter((event) => event.type === "warn" && event.warnType === "endTurn")
    .map((event) => event.message);
const errorsSince = (mark) =>
  eventsSince(mark)
    .filter((event) => event.type === "error")
    .map((event) => event.message);

// The scripted model. Every reply is decided by the request it is
// answering: a body prompt ("brief: ...") gets its answer, a request that
// already holds tool results or a hand-back gets a follow-up, and a fresh
// prompt gets the dispatch it names.
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const asJson = (config) =>
  config.messages.map((message) =>
    typeof message.toJSON === "function" ? message.toJSON() : message,
  );
const lastUserText = (json) => {
  const user = [...json].reverse().find((message) => message.role === "user");
  return typeof user?.content === "string" ? user.content : "";
};
const answer = (output) => ({
  success: true,
  value: { output, toolCalls: [], model: "test", usage: USAGE, cost: COST },
});
const dispatchAll = (calls) => ({
  success: true,
  value: {
    output: null,
    toolCalls: calls.map(([name, args], i) => new ToolCall(`call-${name}-${i}`, name, args)),
    model: "test",
    usage: USAGE,
    cost: COST,
  },
});
const dispatch = (name, args) => dispatchAll([[name, args]]);

const DISPATCHES = {
  "Answer with ender.": () => dispatch("ender", { question: "q" }),
  "Answer with resultEnder.": () => dispatch("resultEnder", { question: "q" }),
  "Answer with jsonEnder.": () => dispatch("jsonEnder", { question: "q" }),
  "Answer with answerer.": () => dispatch("answerer", { question: "a" }),
  "Answer with silentEnder.": () => dispatch("silentEnder", {}),
  "Answer with viaHelper.": () => dispatch("viaHelper", { question: "h" }),
  "Answer with lookup and ender.": () =>
    dispatchAll([
      ["lookup", { key: "k" }],
      ["ender", { question: "q" }],
    ]),
  "Answer with answerer and quiet.": () =>
    dispatchAll([
      ["answerer", { question: "a" }],
      ["quiet", { question: "q" }],
    ]),
  "Answer with answerer twice.": () =>
    dispatchAll([
      ["answerer", { question: "one" }],
      ["answerer", { question: "two" }],
    ]),
  "Answer with messenger.": () => dispatch("messenger", { question: "q" }),
  "Answer with failingMessenger.": () => dispatch("failingMessenger", { question: "q" }),
  "Answer with rejectedMessenger.": () => dispatch("rejectedMessenger", { question: "q" }),
  "Answer with emptyMessage.": () => dispatch("emptyMessage", { question: "q" }),
  "Answer with ordinaryMessenger.": () => dispatch("ordinaryMessenger", { question: "q" }),
  "Answer with endsThenFails.": () => dispatch("endsThenFails", { question: "q" }),
  "Answer with objectEnder match.": () => dispatch("objectEnder", { shape: "match" }),
  "Answer with objectEnder wrong.": () => dispatch("objectEnder", { shape: "wrong" }),
  "Answer with objectEnder plain.": () => dispatch("objectEnder", { shape: "wrong" }),
  "Answer with attacher and answerer.": () =>
    dispatchAll([
      ["attacher", {}],
      ["answerer", { question: "a" }],
    ]),
  "Answer with attacher and ender.": () =>
    dispatchAll([
      ["attacher", {}],
      ["ender", { question: "q" }],
    ]),
  "Answer with pauseAfterMark.": () => dispatch("pauseAfterMark", { id: "p1" }),
  "Answer with pausingEnder.": () => dispatch("pausingEnder", { question: "q" }),
  "Answer with outerHandoff.": () => dispatch("outerHandoff", { question: "q" }),
  "Answer with outerTurnHandoff.": () => dispatch("outerTurnHandoff", { question: "q" }),
  "Answer with parallelEnder.": () => dispatch("parallelEnder", { question: "p" }),
  "Answer with asyncTurnHandoff.": () => dispatch("asyncTurnHandoff", { question: "q" }),
};

const client = {
  async text(config) {
    const json = asJson(config);
    const asked = lastUserText(json);
    const first = typeof json[0]?.content === "string" ? json[0].content : "";
    if (asked.startsWith("json brief:")) {
      return answer(JSON.stringify({ answer: "3 events", done: true }));
    }
    if (asked.startsWith("brief:")) {
      return json[json.length - 1].role === "tool"
        ? answer("inner after pause")
        : dispatchOrAnswer(asked, json);
    }
    if (asked.startsWith("outer brief:")) {
      const wantsTurn =
        first === "Answer with outerTurnHandoff." || first === "Answer with asyncTurnHandoff.";
      const inner = wantsTurn ? "turnEnder" : "ender";
      return dispatch(inner, { question: "in" });
    }
    const followUp = json[json.length - 1].role === "tool" || !(asked in DISPATCHES);
    if (followUp) {
      if (first === "Answer with objectEnder wrong.") {
        return answer(JSON.stringify({ text: "from follow-up" }));
      }
      return answer(`follow-up: ${asked}`);
    }
    return DISPATCHES[asked]();
  },
  async *textStream(config) {
    const reply = await this.text(config);
    yield { type: "done", result: reply.value };
  },
  async embed() {
    return { success: false, error: "not implemented" };
  },
};
// The body prompt of pausingEnder dispatches pauseMe; every other body
// prompt is answered directly.
const dispatchOrAnswer = (asked, json) => {
  const first = typeof json[0]?.content === "string" ? json[0].content : "";
  if (first === "Answer with pausingEnder.") {
    return dispatch("pauseMe", { id: "p2" });
  }
  return answer(`answer to ${asked}`);
};
__setLLMClient(client);

const results = {};
const run = async (name, node, check) => {
  const mark = logMark();
  const { state, callbacks } = makeCapture();
  const value = await node({ callbacks });
  const extra = await check({ state, callbacks, value, mark });
  results[name] = {
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    warnings: warningsSince(mark),
    ...extra,
  };
};

// A handoff ends the turn: two requests (the caller's and the body's),
// the value is the body's answer, and the thread ends on it with no
// hand-back message.
await run("handoffEndsTurn", handoffEndsTurn, ({ state, value }) => ({
  result: value.data,
  lastRequestRoles: roles(last(state)),
  handBackMessages: count(last(state), "finished."),
}));

// A Result-returning handoff: the success is unwrapped before the string check.
await run("resultUnwrapped", resultUnwrapped, ({ value }) => ({ result: value.data }));

// The body's JSON reply is replaced by the answer, so no two assistant
// messages sit side by side and the JSON is gone.
await run("jsonReplaced", jsonReplaced, ({ state, value, callbacks }) => ({
  result: value.data,
  bodySawJsonPrompt: count(state.requests[1], "json brief:"),
}));

// An ordinary tool, the round's only call, ends the turn: one request,
// the tool message paired with its call, and the value is the tool's.
await run("toolEndsTurn", toolEndsTurn, ({ state, value }) => ({
  result: value.data,
  toolStarts: state.toolStarts,
}));

// A tool that returns nothing never ends the turn, and the placeholder
// text is not the answer.
await run("silentEnderFallsBack", silentEnderFallsBack, ({ state, value }) => ({
  result: value.data,
  followUpSawToolResult: toolTexts(last(state)),
}));

// The mark set by a helper the body calls from code belongs to the tool.
await run("viaHelperEnds", viaHelperEnds, ({ value }) => ({ result: value.data }));

// A handoff beside an ordinary call: the other call runs first, the
// handoff counts, and the turn ends after the body.
await run("beside", beside, ({ state, value }) => ({
  result: value.data,
  toolStarts: state.toolStarts,
  bodySawSibling: toolTexts(state.requests[1]).includes("value-of-k"),
}));

// An ordinary tool that marks the turn beside a handoff never saw the
// handoff's work: its mark is dropped and the handoff hands back.
await run("ordinaryBesideHandoff", ordinaryBesideHandoff, ({ state, value }) => ({
  result: value.data,
  toolStarts: state.toolStarts,
  handBack: count(last(state), "[quiet finished. quiet]"),
}));

// Two ordinary tools both mark the turn: neither counts, both warn.
await run("twoMarks", twoMarks, ({ state, value }) => ({
  result: value.data,
  toolTexts: toolTexts(last(state)),
}));

// handBack replaces the default hand-back text, on success and failure.
await run("customMessageSuccess", customMessageSuccess, ({ state, value }) => ({
  result: value.data,
  handBack: lastText(last(state)),
  defaultText: count(last(state), "finished."),
}));
await run("customMessageFailure", customMessageFailure, ({ state, value }) => ({
  result: value.data,
  handBack: lastText(last(state)),
  defaultText: count(last(state), "stopped before finishing"),
}));

// A rejected handoff keeps the rejection text; the custom text is ignored.
await run("rejectedKeepsText", rejectedKeepsText, async ({ state, value, callbacks }) => {
  const resumed = await respondToInterrupts(value.data, [reject("not today")], {
    metadata: { callbacks },
  });
  return {
    result: resumed.data,
    handBack: lastText(last(state)),
    customUsed: count(last(state), "Custom: rejected."),
  };
});

// An empty handBack and a handBack from an ordinary tool are ignored.
await run("emptyMessageIgnored", emptyMessageIgnored, ({ state, value }) => ({
  result: value.data,
  handBack: lastText(last(state)),
}));
await run("ordinaryMessengerIgnored", ordinaryMessengerIgnored, ({ state, value }) => ({
  result: value.data,
  lastRequestRoles: roles(last(state)),
  customUsed: count(last(state), "Custom: ordinary."),
}));

// endTurn() then a failure: the turn goes on with the stopped message.
await run("endsThenFails", endsThenFailsNode, ({ state, value }) => ({
  result: value.data,
  handBack: lastText(last(state)),
}));

// Structured output: a matching value ends the turn with the parsed
// value; a mismatch falls back to the follow-up call.
await run("structuredMatch", structuredMatch, ({ value }) => ({ result: value.data }));
await run("structuredMismatch", structuredMismatch, ({ value }) => ({ result: value.data }));

// No response format and a non-string value: fall back.
await run("nonStringFallback", nonStringFallback, ({ value }) => ({ result: value.data }));

// A reply attachment is waiting: fall back, and the follow-up request
// carries the image. With the ordinary tool the mark is also dropped for
// running beside another call; with the handoff only the attachment rule
// applies.
await run("attachmentFallback", attachmentFallback, ({ state, value }) => ({
  result: value.data,
  followUpCarriesImage: carriesImage(last(state)),
}));
await run("attachmentAlone", attachmentAlone, ({ state, value }) => ({
  result: value.data,
  followUpCarriesImage: carriesImage(last(state)),
  handBack: count(last(state), "[ender finished."),
}));

// The mark is set before the pause, so it rides in the checkpoint.
await run("resumeEndsTurn", resumeEndsTurn, async ({ state, value, callbacks }) => {
  const requestsAtPause = state.requests.length;
  const resumed = await respondToInterrupts(value.data, [approve()], {
    metadata: { callbacks },
  });
  return { result: resumed.data, requestsAtPause };
});

// The pause crosses the handoff body's nested llm() call.
await run("resumeNestedEndsTurn", resumeNestedEndsTurn, async ({ state, value, callbacks }) => {
  const resumed = await respondToInterrupts(value.data, [approve()], {
    metadata: { callbacks },
  });
  return { result: resumed.data, toolStarts: state.toolStarts };
});

// Nested with the default scope: the inner handoff ends the outer body's
// call; the outer hands back and the caller follows up.
await run("nested", nested, ({ state, value }) => ({
  result: value.data,
  handBack: count(last(state), "[outerHandoff finished. answer to brief: in]"),
}));

// Nested with scope "turn": the outer caller makes no follow-up either.
await run("nestedTurn", nestedTurn, ({ state, value }) => ({
  result: value.data,
  lastRequestFirstText: text(last(state)[0]),
}));

// endTurn() inside a parallel branch of the tool body marks the tool.
await run("parallelEndsTurn", parallelEndsTurn, ({ value }) => ({ result: value.data }));

// The body's llm() is an async call; the inner "turn" scope still climbs
// to the handoff's own stack, and the caller makes no follow-up.
await run("asyncNestedTurn", asyncNestedTurn, ({ value }) => ({ result: value.data }));

// endTurn() from code, outside any tool: a statelog error, no effect.
await run("calledFromCode", calledFromCode, ({ value, mark }) => ({
  result: value.data,
  errors: errorsSince(mark),
}));

writeFileSync("__result.json", JSON.stringify(results, null, 2));
