import {
  handlerRejects,
  interactiveReject,
  fiveRejectionsRemove,
  destructiveReject,
  approvalResets,
  parallelRejectAndPause,
  respondToInterrupts,
  approve,
  reject,
} from "./agent.js";
import { writeFileSync } from "fs";

// Capture every tool-role message the model sees, via onLLMCallStart:
// each round's request carries the tool results of the previous round.
const makeCapture = () => {
  const state = { toolMessages: [], toolStarts: 0, lastMessages: [] };
  const callbacks = {
    onLLMCallStart: ({ messages }) => {
      state.lastMessages = messages;
      for (const m of messages) {
        if (m.role === "tool") {
          const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          if (!state.toolMessages.includes(text)) state.toolMessages.push(text);
        }
      }
    },
    onToolCallStart: () => {
      state.toolStarts += 1;
    },
  };
  return { state, callbacks };
};

const seen = (state, substring) => state.toolMessages.some((m) => m.includes(substring));

const results = {};

// Handler rejects with a reason. The model must see the reason (not a
// generic error), the no-retry instruction, and — on the scripted
// identical retry — the already-rejected refusal, with the tool invoked
// only once.
{
  const { state, callbacks } = makeCapture();
  const result = await handlerRejects({ callbacks });
  results.handlerRejects = {
    result: result.data,
    toolStarts: state.toolStarts,
    reasonSeen: seen(state, "Tool call rejected: no tools for you"),
    noRetrySuffixSeen: seen(state, "Do not call this tool with the same arguments again"),
    identicalRetryRefused: seen(state, "was already rejected and will not be executed"),
    framedAsError: seen(state, "Error:"),
  };
}

// No handler: the run pauses, the test rejects interactively with a
// reason. After resume the model must see that reason.
{
  const { state, callbacks } = makeCapture();
  const paused = await interactiveReject({ callbacks });
  const pausedWithInterrupt =
    Array.isArray(paused.data) && paused.data[0]?.type === "interrupt";
  const resumed = await respondToInterrupts(
    paused.data,
    [reject("b is forbidden today")],
    { metadata: { callbacks } },
  );
  results.interactiveReject = {
    pausedWithInterrupt,
    result: resumed.data,
    reasonSeen: seen(state, "Tool call rejected: b is forbidden today"),
  };
}

// Five consecutive rejections remove the tool: the fifth rejection's
// message says so, and the sixth scripted call never starts.
{
  const { state, callbacks } = makeCapture();
  const result = await fiveRejectionsRemove({ callbacks });
  results.fiveRejectionsRemove = {
    result: result.data,
    toolStarts: state.toolStarts,
    removalSeen: seen(state, "rejected too many times"),
  };
}

// A destructive def commits destructiveRan at entry, so its rejected gate
// is not a clean rejection: the destructive failure tier removes the tool
// immediately, and the second scripted call never starts.
{
  const { state, callbacks } = makeCapture();
  const result = await destructiveReject({ callbacks });
  results.destructiveReject = {
    result: result.data,
    toolStarts: state.toolStarts,
    destructiveTierSeen: seen(state, "Verify state manually"),
    rejectionPathSeen: seen(state, "Tool call rejected:"),
  };
}

// An approved call resets the count: four rejections, an approval, one
// more rejection, then another approved call. Without the reset, the
// post-approval rejection would be the fifth strike and the final call
// would never start (toolStarts 6, not 7).
{
  const { state, callbacks } = makeCapture();
  const result = await approvalResets({ callbacks });
  results.approvalResets = {
    result: result.data,
    toolStarts: state.toolStarts,
    removalSeen: seen(state, "rejected too many times"),
  };
}

// Replay safety: guardedTool is rejected while its parallel sibling
// pauses. On resume, the rejected branch's message is already in the
// checkpointed thread — the replay must not push a second one. The
// final request must hold exactly TWO tool messages (one rejection,
// one success), counted WITH duplicates via lastMessages.
{
  const { state, callbacks } = makeCapture();
  const paused = await parallelRejectAndPause({ callbacks });
  const pausedWithInterrupt =
    Array.isArray(paused.data) && paused.data[0]?.type === "interrupt";
  const resumed = await respondToInterrupts(paused.data, [approve()], {
    metadata: { callbacks },
  });
  const toolContents = state.lastMessages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  results.parallelRejectAndPause = {
    pausedWithInterrupt,
    result: resumed.data,
    toolMessagesInFinalRequest: toolContents.length,
    rejectionMessages: toolContents.filter((c) => c.includes("Tool call rejected: no guardedTool"))
      .length,
  };
}

writeFileSync("__result.json", JSON.stringify(results, null, 2));
