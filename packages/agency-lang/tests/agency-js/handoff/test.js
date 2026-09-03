import {
  basic,
  persona,
  notAlone,
  threadInside,
  subthreadInside,
  pauseInside,
  rejectInside,
  failureInside,
  rejectHandoff,
  nested,
  pauseWithPersona,
  twoDispatches,
  twoHandoffs,
  handoffWithDraft,
  objectResult,
  nestedPause,
  asyncHandoff,
  explicitMessages,
  callerSystemVisible,
  twoAsyncHandoffs,
  cancelledHandoff,
  respondToInterrupts,
  approve,
  reject,
  __setLLMClient,
} from "./agent.js";
import { writeFileSync } from "fs";
import { ToolCall } from "smoltalk";

// Record every request the model sees, in order. The last request of a
// node is the caller's final round, which shows the caller's thread
// after the handoff came back.
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
const count = (messages, needle) =>
  messages.filter((message) => text(message).includes(needle)).length;
const hasToolCalls = (message) =>
  Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
const toolTexts = (messages) =>
  messages.filter((message) => message.role === "tool").map(text).sort();

// Would a real provider accept this request? The mock client accepts
// anything, so this is the check that a handoff never leaves a dangling
// tool call behind: every assistant message that carries N tool calls
// is followed by exactly N tool messages, tool messages appear nowhere
// else, and a request never ends on an assistant message.
const wellFormed = (messages) => {
  let owed = 0;
  for (const message of messages) {
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

const results = {};

// The subagent's messages land on the caller's thread: the marker
// replaces the tool call, the leaf tool's exchange stays paired, and the
// resume message carries the result. The subagent's first request shows
// it saw the caller's history.
{
  const { state, callbacks } = makeCapture();
  const result = await basic({ callbacks });
  const final = last(state);
  const subagentFirst = state.requests[1];
  results.basic = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    roles: roles(final),
    markerOnAssistant:
      final[1].role === "assistant" &&
      text(final[1]).includes("[dispatching subagent") &&
      !hasToolCalls(final[1]),
    toolTexts: toolTexts(final),
    resumeCarriesResult: text(final[final.length - 1]).includes(
      "[subagent finished. inner answer]",
    ),
    subagentSawCaller:
      text(subagentFirst[0]) === "Answer with the subagent." &&
      count(subagentFirst, "[dispatching subagent") === 1,
    toolStarts: state.toolStarts,
  };
}

// A system message the body pushes is visible to the body's own request
// and gone from the caller's thread afterwards.
{
  const { state, callbacks } = makeCapture();
  const result = await persona({ callbacks });
  results.persona = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    bodySawPersona: count(state.requests[1], "persona: be terse"),
    callerKeptPersona: count(last(state), "persona: be terse"),
    roles: roles(last(state)),
  };
}

// A handoff beside another call is refused as an ordinary tool message;
// the sibling runs; the assistant message keeps its tool calls.
{
  const { state, callbacks } = makeCapture();
  const result = await notAlone({ callbacks });
  const final = last(state);
  results.notAlone = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    refused: count(final, "must be the only tool call in its round"),
    siblingRan: toolTexts(final).includes("value-of-k3"),
    assistantKeptToolCalls: hasToolCalls(final[1]),
    toolStarts: state.toolStarts,
    markers: count(final, "[dispatching"),
  };
}

// thread {} inside a handoff body still isolates: the body's request
// starts empty and none of its messages reach the caller.
{
  const { state, callbacks } = makeCapture();
  const result = await threadInside({ callbacks });
  results.threadInside = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    bodyRequestLength: state.requests[1].length,
    roles: roles(last(state)),
    resume: count(last(state), "[threadedAgent finished. threaded answer]"),
  };
}

// subthread {} inside a handoff body inherits the caller's history and
// does not flow back.
{
  const { state, callbacks } = makeCapture();
  const result = await subthreadInside({ callbacks });
  results.subthreadInside = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    bodySawCaller: count(state.requests[1], "[dispatching subthreadedAgent"),
    roles: roles(last(state)),
    resume: count(last(state), "[subthreadedAgent finished. subthreaded answer]"),
  };
}

// An interrupt inside the body pauses the run. After approval the run
// resumes without a second marker or a second resume message.
{
  const { state, callbacks } = makeCapture();
  const paused = await pauseInside({ callbacks });
  const pausedWithInterrupt =
    Array.isArray(paused.data) && paused.data[0]?.type === "interrupt";
  const resumed = await respondToInterrupts(paused.data, [approve()], {
    metadata: { callbacks },
  });
  const final = last(state);
  results.pauseInside = {
    pausedWithInterrupt,
    result: resumed.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    markers: count(final, "[dispatching pausingAgent"),
    resumes: count(final, "pausingAgent finished"),
    roles: roles(final),
    toolTexts: toolTexts(final),
  };
}

// The same pause, rejected. The rejection is the leaf tool's, inside the
// body, so it reaches the body's own model as a tool message and the
// body still hands back normally.
{
  const { state, callbacks } = makeCapture();
  const paused = await rejectInside({ callbacks });
  const resumed = await respondToInterrupts(paused.data, [reject("not today")], {
    metadata: { callbacks },
  });
  const final = last(state);
  results.rejectInside = {
    result: resumed.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    rejectionSeenByBody: count(final, "Tool call rejected: not today"),
    markers: count(final, "[dispatching pausingAgent"),
    resumes: count(final, "[pausingAgent finished. rejected answer]"),
    roles: roles(final),
  };
}

// A body that returns a failure hands back with the error in the resume
// message and no tool message anywhere.
{
  const { state, callbacks } = makeCapture();
  const result = await failureInside({ callbacks });
  const final = last(state);
  results.failureInside = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    roles: roles(final),
    resumeCarriesError: count(final, "[failingAgent finished. Error: boom"),
  };
}

// The handoff call itself is rejected: the body raises before its
// llm(), the rejection makes the body return a rejected failure, and the
// outer loop's recordRejection hands back through the resume message.
// No tool message anywhere, and the marker stays.
{
  const { state, callbacks } = makeCapture();
  const paused = await rejectHandoff({ callbacks });
  const resumed = await respondToInterrupts(paused.data, [reject("nope")], {
    metadata: { callbacks },
  });
  const final = last(state);
  results.rejectHandoff = {
    result: resumed.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    roles: roles(final),
    markers: count(final, "[dispatching gatedAgent"),
    resumeCarriesRejection: count(final, "[gatedAgent finished. Tool call rejected: nope"),
  };
}

// A handoff inside a handoff: two markers, two resumes, no tool
// messages, all on the one thread.
{
  const { state, callbacks } = makeCapture();
  const result = await nested({ callbacks });
  const final = last(state);
  results.nested = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    roles: roles(final),
    markers: count(final, "[dispatching"),
    resumes: count(final, "finished."),
    toolMessages: final.filter((message) => message.role === "tool").length,
  };
}

// The body pushes a persona and then pauses. Stripping it after the
// resume needs the start index recorded before the checkpoint.
{
  const { state, callbacks } = makeCapture();
  const paused = await pauseWithPersona({ callbacks });
  const resumed = await respondToInterrupts(paused.data, [approve()], {
    metadata: { callbacks },
  });
  const final = last(state);
  results.pauseWithPersona = {
    result: resumed.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    bodySawPersona: count(state.requests[1], "persona: be patient"),
    callerKeptPersona: count(final, "persona: be patient"),
    markers: count(final, "[dispatching pausingPersonaAgent"),
    roles: roles(final),
  };
}

// The same agent dispatched twice. ensureSystemMessage pushes the persona
// on each dispatch, because the hand-back strips it, and never twice
// within one dispatch.
{
  const { state, callbacks } = makeCapture();
  const result = await twoDispatches({ callbacks });
  const final = last(state);
  results.twoDispatches = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    firstBodySawPersona: count(state.requests[1], "persona: be terse"),
    secondBodySawPersona: count(state.requests[3], "persona: be terse"),
    callerKeptPersona: count(final, "persona: be terse"),
    markers: count(final, "[dispatching terseAgent"),
    resumes: count(final, "terseAgent finished"),
  };
}

// Two handoffs in one round: both are refused, neither runs.
{
  const { state, callbacks } = makeCapture();
  const result = await twoHandoffs({ callbacks });
  const final = last(state);
  results.twoHandoffs = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    refused: count(final, "must be the only tool call in its round"),
    toolStarts: state.toolStarts,
    markers: count(final, "[dispatching"),
  };
}

// A handoff beside an intrinsic saveDraft call is a mixed round too: the
// draft is filed and the handoff is refused.
{
  const { state, callbacks } = makeCapture();
  const result = await handoffWithDraft({ callbacks });
  const final = last(state);
  results.handoffWithDraft = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    refused: count(final, "must be the only tool call in its round"),
    toolStarts: state.toolStarts,
    markers: count(final, "[dispatching"),
  };
}

// A structured return value is stringified into the resume message.
{
  const { state, callbacks } = makeCapture();
  const result = await objectResult({ callbacks });
  const final = last(state);
  results.objectResult = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    roles: roles(final),
    resumeCarriesJson: count(final, '[objectAgent finished. {"answer":"obj","n":1}]'),
  };
}

// A pause inside a handoff inside a handoff: two runPrompt frames each
// hold their own start index, and both resume without duplicating a
// marker or a resume message.
{
  const { state, callbacks } = makeCapture();
  const paused = await nestedPause({ callbacks });
  const resumed = await respondToInterrupts(paused.data, [approve()], {
    metadata: { callbacks },
  });
  const final = last(state);
  results.nestedPause = {
    result: resumed.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    roles: roles(final),
    markers: count(final, "[dispatching"),
    resumes: count(final, "finished."),
    toolTexts: toolTexts(final),
  };
}

// A handoff inside an async prompt lands on the prompt's subthread. The
// main thread's next request must not see any of it.
{
  const { state, callbacks } = makeCapture();
  const result = await asyncHandoff({ callbacks });
  const final = last(state);
  results.asyncHandoff = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    bodySawCaller: count(state.requests[1], "[dispatching subagent"),
    asyncFinalRoles: roles(state.requests[2]),
    mainThreadRoles: roles(final),
    mainThreadSawHandoff: count(final, "[dispatching") + count(final, "async inner"),
  };
}

// A handoff inside a prompt with explicit messages lands on that thread,
// which the store had never seen. The active thread's next request must
// not see any of it.
{
  const { state, callbacks } = makeCapture();
  const result = await explicitMessages({ callbacks });
  const final = last(state);
  results.explicitMessages = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    bodySawExplicit:
      count(state.requests[1], "earlier context") === 1 &&
      count(state.requests[1], "[dispatching subagent") === 1,
    explicitFinalRoles: roles(state.requests[2]),
    activeThreadRoles: roles(final),
    activeThreadSawHandoff: count(final, "[dispatching") + count(final, "explicit inner"),
  };
}

// The caller's own system prompt is visible to the body and is still
// there after the hand-back; the strip reaches only past the marker.
{
  const { state, callbacks } = makeCapture();
  const result = await callerSystemVisible({ callbacks });
  const final = last(state);
  results.callerSystemVisible = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    bodySawCallerRules: count(state.requests[1], "caller rules"),
    bodySawOwnPersona: count(state.requests[1], "persona: be terse"),
    callerKeptRules: count(final, "caller rules"),
    callerKeptPersona: count(final, "persona: be terse"),
    roles: roles(final),
  };
}

// The scenarios below need a model that answers by what it was asked,
// because their requests interleave and a queue in call order would
// hand the wrong script to the wrong prompt. `lastUserText` is the most
// recent user message of the request.
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const lastUserText = (config) => {
  const json = config.messages.map((message) =>
    typeof message.toJSON === "function" ? message.toJSON() : message,
  );
  const user = [...json].reverse().find((message) => message.role === "user");
  return typeof user?.content === "string" ? user.content : "";
};
const answer = (output) => ({
  success: true,
  value: { output, toolCalls: [], model: "test", usage: USAGE, cost: COST },
});
const dispatch = (name, args) => ({
  success: true,
  value: {
    output: null,
    toolCalls: [new ToolCall(`call-${name}`, name, args)],
    model: "test",
    usage: USAGE,
    cost: COST,
  },
});
const parkUntilAbort = (config) =>
  new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    const signal = config?.abortSignal;
    if (!signal) {
      reject(new Error("expected an abortSignal on the parked request"));
      return;
    }
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()));
  });
const answeringClient = (rules) => ({
  async text(config) {
    return rules(lastUserText(config), config);
  },
  async *textStream(config) {
    const reply = await this.text(config);
    yield { type: "done", result: reply.value };
  },
  async embed() {
    return { success: false, error: "not implemented" };
  },
});

// Two async prompts, each dispatching a handoff at the same time. Each
// prompt's final request holds exactly its own body; the main thread
// holds neither.
{
  __setLLMClient(
    answeringClient((asked) => {
      if (asked === "A" || asked === "B") {
        return dispatch("subagent", { question: asked });
      }
      if (asked.startsWith("brief:")) {
        return answer("inner");
      }
      if (asked.startsWith("[subagent finished")) {
        return answer("async done");
      }
      return answer("main sees");
    }),
  );
  const { state, callbacks } = makeCapture();
  const result = await twoAsyncHandoffs({ callbacks });
  const finals = state.requests.filter((messages) => count(messages, "[subagent finished") === 1);
  const main = last(state);
  results.twoAsyncHandoffs = {
    result: result.data,
    requestCount: state.requests.length,
    allWellFormed: allWellFormed(state),
    asyncFinals: finals.length,
    eachFinalHoldsOneBody: finals.every(
      (messages) =>
        roles(messages).join(",") === "user,assistant,user,assistant,user" &&
        count(messages, "[dispatching subagent") === 1 &&
        count(messages, "brief: " + text(messages[0])) === 1,
    ),
    mainThreadRoles: roles(main),
    mainThreadSawHandoff: count(main, "[dispatching"),
  };
}

// A race loser inside a handoff body. The winner is held until the
// loser's body has pushed its persona and sent its request, so the abort
// lands mid-body. The persona is gone from the loser's thread afterwards
// and the marker stays as the record of the attempt.
{
  let releaseWinner = () => {};
  const parkedRequestStarted = new Promise((resolve) => {
    releaseWinner = resolve;
  });
  __setLLMClient(
    answeringClient(async (asked, config) => {
      if (asked === "fast") {
        await parkedRequestStarted;
        return answer("fast");
      }
      if (asked === "slow") {
        return dispatch("parkingAgent", { question: "p" });
      }
      releaseWinner();
      return parkUntilAbort(config);
    }),
  );
  const { state, callbacks } = makeCapture();
  const result = await cancelledHandoff({ callbacks });
  const threads = Array.isArray(result.data) ? result.data : [];
  const loser = threads.find((messages) => count(messages, "[dispatching parkingAgent") === 1);
  results.cancelledHandoff = {
    loserThreadFound: loser !== undefined,
    parkedRequestSawPersona: state.requests.some(
      (messages) => count(messages, "parked: p") === 1 && count(messages, "persona: be parked") === 1,
    ),
    loserKeptPersona: loser === undefined ? null : count(loser, "persona: be parked"),
    loserKeptMarker: loser === undefined ? null : count(loser, "[dispatching parkingAgent"),
    loserMarkedCancelled: loser === undefined ? null : count(loser, "[Response cancelled.]"),
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
