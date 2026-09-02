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
  respondToInterrupts,
  approve,
  reject,
} from "./agent.js";
import { writeFileSync } from "fs";

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
    markers: count(final, "[dispatching pausingAgent"),
    resumes: count(final, "pausingAgent finished"),
    roles: roles(final),
    toolTexts: toolTexts(final),
  };
}

// The same pause, rejected. The rejection is the leaf tool's, inside the
// body, so it reaches the body's own model as a tool message and the
// body still hands back normally. This pins the rejection route through
// the loop that runs inside a handoff.
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
    roles: roles(final),
    markers: count(final, "[dispatching"),
    resumes: count(final, "finished."),
    toolMessages: final.filter((message) => message.role === "tool").length,
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
