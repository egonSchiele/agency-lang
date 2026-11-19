// Drives the agent's session program (lib/agents/agency-agent/program.agency)
// the way a front-end does: start it, answer its pause, read its events.
// No model is called: a test client answers every llm() call.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The agent home is read when the modules load, so it is set first. A temp
// home keeps the test out of the user's settings and sessions.
process.env.AGENCY_AGENT_HOME = mkdtempSync(path.join(os.tmpdir(), "session-core-home-"));
process.env.ANTHROPIC_API_KEY = "test-key";
const project = mkdtempSync(path.join(os.tmpdir(), "session-core-project-"));

const program = await import("../../../dist/lib/agents/agency-agent/program.js");
const { main, respondToInterrupts, approve, hasInterrupts, __setLLMClient } = program;

const PAUSE = "agent::sessionInput";
const PIN = { [PAUSE]: [{ action: "propagate" }] };

function lastUserText(config) {
  const users = config.messages.filter((message) => message.role === "user");
  if (users.length === 0) return "";
  const content = users[users.length - 1].content;
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

__setLLMClient({
  async text(config) {
    if (lastUserText(config).includes("fail this turn")) {
      throw new Error("the test client was told to fail");
    }
    return {
      success: true,
      value: {
        output: "stub reply",
        toolCalls: [],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      },
    };
  },
  async *textStream(config) {
    const response = await this.text(config);
    yield { type: "done", result: response.value };
  },
  async embed() {
    throw new Error("Unexpected embedding request in the session core test");
  },
});

function startData(overrides = {}) {
  return {
    brain: "simple",
    preset: "",
    models: { pin: "claude-sonnet-4-6", slots: {}, provider: "", local: null, effort: null },
    limits: { maxToolCallRounds: null, maxToolResultChars: null },
    oneShot: false,
    session: {
      cwd: project,
      replyStyle: "",
      record: { id: "s1", cwd: project, brain: "", created: 1, lastActive: 1, turns: 0, title: "" },
      startedWith: "",
    },
    ...overrides,
  };
}

/** One session, as a front-end holds it: the pause it waits at, and
 *  everything it emitted. */
async function startSession(overrides = {}, policy = PIN) {
  const emitted = [];
  const callbacks = { onEmit: (event) => void emitted.push(event) };
  const first = await main(startData(overrides), { callbacks, policy });
  const session = {
    pause: first.data,
    emitted,
    ended: !hasInterrupts(first.data),
    result: first.data,
  };
  session.answer = async (value) => {
    const next = await respondToInterrupts(session.pause, [approve(value)], {
      metadata: { callbacks },
      invocation: { policy },
    });
    session.result = next.data;
    session.ended = !hasInterrupts(next.data);
    if (!session.ended) session.pause = next.data;
    return next.data;
  };
  return session;
}

const message = (text) => ({ kind: "message", text, notes: [], target: "" });
const pauseData = (session) => session.pause[0].data;
const eventsOf = (session, type) => session.emitted.filter((event) => event.type === type);
const errorText = (data) => String(data?.error ?? "");
const withinFiveSeconds = (promise) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("hung"), 5000))]);

const result = {};

// A turn.
const chat = await startSession();
result.firstPauseEffect = chat.pause[0].effect;
result.firstPauseModules = Object.keys(chat.pause[0].checkpoint?.moduleFingerprints ?? {});
result.mainSlotIsSet = pauseData(chat).models.main?.model === "claude-sonnet-4-6";
result.recordHasTheRealBrain = pauseData(chat).record.brain;
await chat.answer(message("hello"));
result.reply = eventsOf(chat, "session.reply").map((event) => event.text);
result.turnsAfterOneMessage = pauseData(chat).record.turns;

// An answer that is not an Answer.
await chat.answer("just a string");
result.badAnswer = eventsOf(chat, "session.error")[0]?.message.slice(0, 40);
result.badAnswerPausedAgain = chat.pause[0].effect === PAUSE;

// The budget.
await chat.answer({ kind: "budget", maxCost: 2, maxTime: 60000 });
result.budgetAfterAnswer = pauseData(chat).budget;

// A model that does not resolve, then one that does.
await chat.answer({ kind: "model", spec: "resoning=opus" });
const notices = eventsOf(chat, "session.notice");
result.badModelNoticeLevel = notices[notices.length - 1]?.level;
result.badModelKeptMainSlot = pauseData(chat).models.main?.model === "claude-sonnet-4-6";
await chat.answer({ kind: "model", spec: "claude-opus-4-8" });
result.goodModelChangedMainSlot = pauseData(chat).models.main?.model;

// A turn that fails. The session goes on, and the turn is counted.
const errorsBefore = eventsOf(chat, "session.error").length;
const repliesBefore = eventsOf(chat, "session.reply").length;
await chat.answer(message("fail this turn"));
result.failedTurnErrors = eventsOf(chat, "session.error").length - errorsBefore;
result.failedTurnReplies = eventsOf(chat, "session.reply")
  .slice(repliesBefore)
  .map((event) => event.text.slice(0, 34));
result.pausedAgainAfterFailure = !chat.ended && chat.pause[0].effect === PAUSE;
result.turnsAfterTheFailedTurn = pauseData(chat).record.turns;
await chat.answer(message("hello again"));
result.replyAfterTheFailedTurn = eventsOf(chat, "session.reply").pop()?.text;

// An answer of nothing ends the session.
await chat.answer(null);
result.nullAnswerEndsTheRun = chat.ended;

// A policy that would answer the pause, with the pin forgotten.
const unpinned = await withinFiveSeconds(startSession({}, { "*": [{ action: "approve" }] }));
result.approveAllWithoutThePin =
  unpinned === "hung" ? "hung" : unpinned.ended ? "ended" : `paused on ${unpinned.pause[0].effect}`;

// Setups that fail end the run with the reason. The process goes on.
const badBrain = await startSession({ brain: "no-such-brain" });
result.unknownBrainEndsTheRun = badBrain.ended && errorText(badBrain.result).slice(0, 13);
const badPreset = await startSession({ preset: "no-such-preset" });
result.unusablePresetEndsTheRun = badPreset.ended && errorText(badPreset.result) !== "";
result.processStillAliveAfterFailedSetups = true;

writeFileSync("__result.json", JSON.stringify(result, null, 2));
process.exit(0);
