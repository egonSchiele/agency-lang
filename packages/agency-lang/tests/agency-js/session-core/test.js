// Drives the agent's session program (lib/agents/agency-agent/program.agency)
// the way a front-end does: start it, answer its pause, read its events.
// No model is called: a test client answers every llm() call.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCall } from "smoltalk";

// The agent home is read when the modules load, so it is set first. A temp
// home keeps the test out of the user's settings and sessions.
process.env.AGENCY_AGENT_HOME = mkdtempSync(path.join(os.tmpdir(), "session-core-home-"));
process.env.ANTHROPIC_API_KEY = "test-key";
const project = mkdtempSync(path.join(os.tmpdir(), "session-core-project-"));

const program = await import("../../../dist/lib/agents/agency-agent/program.js");
const { main, respondToInterrupts, approve, hasInterrupts, __setLLMClient } = program;
// Whether this process can host a local model: a front-end says so once.
const { _setLocalModelsAllowed, _setManySessions } = await import(
  "../../../dist/lib/stdlib/agentProcess.js"
);
_setManySessions(true);

const PAUSE = "agent::sessionInput";
const PIN = { [PAUSE]: [{ action: "propagate" }] };

function lastUserText(config) {
  const users = config.messages.filter((message) => message.role === "user");
  if (users.length === 0) return "";
  const content = users[users.length - 1].content;
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

// The temperature and the effort each model call was sent, keyed by the
// call's last user message.
const temperatureSent = {};
const effortSent = {};

__setLLMClient({
  async text(config) {
    const said = lastUserText(config);
    temperatureSent[said] = config.temperature ?? "none";
    effortSent[said] = config.reasoningEffort ?? "none";
    if (said.includes("edit the note")) {
      // One edit, then a reply once the tool's result is in the conversation.
      const edited = config.messages.some((message) => message.role === "tool");
      const edit = new ToolCall("call-edit", "edit", {
        filename: "note.txt",
        edits: [{ oldText: "old line", newText: "new line", replaceAll: false }],
        dir: project,
      });
      return {
        success: true,
        value: {
          output: edited ? "edited" : null,
          toolCalls: edited ? [] : [edit],
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
          cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
        },
      };
    }
    if (said.includes("fail this turn")) {
      throw new Error("the test client was told to fail");
    }
    // A call that costs more than the turn budget the test sets.
    const spent = said.includes("an expensive question") ? 5 : 0;
    return {
      success: true,
      value: {
        output: "stub reply",
        toolCalls: [],
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        cost: { inputCost: spent, outputCost: 0, totalCost: spent, currency: "USD" },
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
    session: {
      cwd: project,
      replyStyle: "",
      record: { id: "s1", cwd: project, brain: "", created: 1, lastActive: 1, turns: 0, title: "" },
      flags: null,
      budget: { maxCost: -1, maxTime: -1 },
      policy: null,
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
result.firstPauseBrain = pauseData(chat).brain;
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
// A spec naming a provider the core does not know is refused.
const noticesBeforeUnknown = eventsOf(chat, "session.notice").length;
await chat.answer({ kind: "model", spec: "groq/llama-3" });
const unknownNotice = eventsOf(chat, "session.notice").slice(noticesBeforeUnknown).pop();
result.unknownProviderRefused = {
  level: unknownNotice?.level,
  text: unknownNotice?.text?.slice(0, 40),
  mainKept: pauseData(chat).models.main?.model,
};

// The session's own LLM options reach the next turn's model call.
await chat.answer({ kind: "options", options: { temperature: 0.2 } });
await chat.answer(message("with a temperature"));
result.temperatureSentAfterOptions = temperatureSent["with a temperature"];
const errorsBeforeBadOptions = eventsOf(chat, "session.error").length;
await chat.answer({ kind: "options", options: "low" });
result.optionsRefusal = eventsOf(chat, "session.error").pop()?.message;
result.optionsThatAreNotAnObjectAreRefused =
  eventsOf(chat, "session.error").length - errorsBeforeBadOptions;

// A start target the brain does not have is refused, and is not a turn.
const turnsBeforeBadTarget = pauseData(chat).record.turns;
await chat.answer({ kind: "message", text: "hi", notes: [], target: "code" });
result.unknownTargetError = eventsOf(chat, "session.error").pop()?.message;
result.unknownTargetIsNotATurn = pauseData(chat).record.turns === turnsBeforeBadTarget;

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

// The turn budget reaches the turn: a call that costs more than it stops the turn.
await chat.answer({ kind: "budget", maxCost: 2, maxTime: 60000 });
await chat.answer(message("an expensive question"));
result.overBudgetTurn = {
  budgetStops: eventsOf(chat, "session.budgetStop").map((event) => event.dimension),
  reply: eventsOf(chat, "session.reply").pop()?.text.slice(0, 60),
};

// The effort. It is its own answer, since it is not one of the LLM options.
result.effortBeforeAnyChoice = pauseData(chat).effort;
await chat.answer({ kind: "effort", effort: "low" });
result.effortAfterLow = pauseData(chat).effort;
await chat.answer(message("with low effort"));
result.effortSentAfterLow = effortSent["with low effort"];
// It outlasts a model switch, as --effort does.
await chat.answer({ kind: "model", spec: "claude-sonnet-4-6" });
result.effortAfterAModelSwitch = pauseData(chat).effort;
await chat.answer({ kind: "effort", effort: "default" });
await chat.answer(message("with the provider's own effort"));
result.effortSentAfterDefault = effortSent["with the provider's own effort"];
await chat.answer({ kind: "effort", effort: "extreme" });
const effortNotice = eventsOf(chat, "session.notice").pop();
result.badEffort = { level: effortNotice?.level, text: effortNotice?.text, kept: pauseData(chat).effort };

// A preset that does not exist changes nothing.
await chat.answer({ kind: "preset", name: "no-such-preset" });
result.unknownPreset = {
  level: eventsOf(chat, "session.notice").pop()?.level,
  presetKept: pauseData(chat).preset,
  mainModelKept: pauseData(chat).models.main?.model,
};

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
// A local model, where the process cannot host one: refused before anything is loaded.
_setLocalModelsAllowed(false);
const localRefused = await startSession({
  models: { pin: "", slots: {}, provider: "", local: "no-such-model", effort: null },
});
result.localModelWhereNoneCanRun = localRefused.ended && errorText(localRefused.result);
_setLocalModelsAllowed(true);

// A start that does not fit the program's type is refused by name. A
// front-end built for another version of the program sends one.
const { budget: _left, ...sessionWithoutABudget } = startData().session;
const misfit = await startSession({ session: sessionWithoutABudget });
result.startMissingAField = misfit.ended && errorText(misfit.result);
// The process goes on: the next session starts and reaches its pause.
const afterFailures = await startSession();
result.sessionStartsAfterFailedSetups = !afterFailures.ended && afterFailures.pause[0].effect;

// Starting sessions leaves the user's settings file alone. An app's
// environment often lacks the search keys a terminal has, and a choice
// saved from there would follow the user back to the terminal.
result.settingsFileWritten = existsSync(path.join(process.env.AGENCY_AGENT_HOME, "settings.json"));

// An edit's diff is an event, for an edit the policy approves too: no one
// is asked, and a front-end still has the diff to show on the edit's row.
writeFileSync(path.join(project, "note.txt"), "first\nold line\nlast\n");
// The minimal brain: the simple one has no tools.
const editor = await startSession({ brain: "minimal" }, { ...PIN, "std::edit": [{ action: "approve" }] });
await editor.answer(message("edit the note"));
const diffs = eventsOf(editor, "session.editDiff");
result.editDiff = {
  events: diffs.length,
  filename: diffs[0]?.filename,
  edits: diffs[0]?.edits,
  lines: (diffs[0]?.hunks ?? []).flatMap((hunk) =>
    hunk.lines.map((line) => `${line.kind} ${line.tokens.map((token) => token.text).join("")}`),
  ),
  pausedOn: editor.pause[0].effect,
  reply: eventsOf(editor, "session.reply").pop()?.text,
  fileAfter: readFileSync(path.join(project, "note.txt"), "utf8"),
};

// An edit no rule decides leaves the run as an approval. It is reported
// once: not again when the approved edit goes on.
writeFileSync(path.join(project, "note.txt"), "first\nold line\nlast\n");
const asker = await startSession({ brain: "minimal" });
await asker.answer(message("edit the note"));
result.editThatIsAsked = {
  pausedOn: asker.pause[0].effect,
  eventsAtTheApproval: eventsOf(asker, "session.editDiff").length,
};
await asker.answer(undefined);
result.editThatIsAsked.eventsAfterApproving = eventsOf(asker, "session.editDiff").length;
result.editThatIsAsked.fileAfter = readFileSync(path.join(project, "note.txt"), "utf8");

// The agent's own scans of what it learned are approved by the core: under
// a policy with no rules, a turn asks nothing about them.
mkdirSync(path.join(process.env.AGENCY_AGENT_HOME, "skills"), { recursive: true });
mkdirSync(path.join(process.env.AGENCY_AGENT_HOME, "tools"), { recursive: true });
const scanner = await startSession({ brain: "coordinator" });
await scanner.answer(message("a turn that lists the learned things"));
result.learnedScansAskNothing = {
  pausedOn: scanner.pause[0].effect,
  reply: eventsOf(scanner, "session.reply").pop()?.text,
};

// A session can start with a turn budget.
const budgeted = await startSession({
  session: { ...startData().session, budget: { maxCost: 3, maxTime: 1000 } },
});
result.startingBudget = pauseData(budgeted).budget;

// A session started with policy flags carries the policy they resolved
// to, at every pause, so whoever resumes it runs it under that policy.
const editsRejected = { "std::edit": [{ action: "reject" }] };
const carrying = await startSession({ session: { ...startData().session, policy: editsRejected } });
result.policyCarried = { atFirstPause: pauseData(carrying).policy };
await carrying.answer(message("hello"));
result.policyCarried.afterATurn = pauseData(carrying).policy;
await carrying.answer({ kind: "budget", maxCost: 1, maxTime: 1000 });
result.policyCarried.afterABudgetAnswer = pauseData(carrying).policy;
await carrying.answer({ kind: "effort", effort: "low" });
result.policyCarried.afterAnEffortAnswer = pauseData(carrying).policy;
result.policyCarried.withNoPolicyFlag = pauseData(budgeted).policy;
// A front-end built before the field existed sends no `policy` at all. Its
// start is not refused, and the session carries none.
const { policy: _absent, ...sessionWithNoPolicyField } = startData().session;
const olderFrontEnd = await startSession({ session: sessionWithNoPolicyField });
result.policyCarried.withNoPolicyField = olderFrontEnd.ended
  ? `refused: ${errorText(olderFrontEnd.result)}`
  : pauseData(olderFrontEnd).policy;

// Presets. These need a settings file, so they come after the check above
// that starting sessions writes none. The session names no model, so the
// preset's is the one in force.
const settingsFile = path.join(process.env.AGENCY_AGENT_HOME, "settings.json");
writeFileSync(
  settingsFile,
  JSON.stringify({
    presets: {
      big: { provider: "anthropic", pin: "claude-opus-4-8", effort: "high" },
      mine: { local: "no-such-local-model" },
    },
  }),
);
const noModelFlags = { pin: "", slots: {}, provider: "", local: null, effort: null };
_setLocalModelsAllowed(false);
const preset = await startSession({ models: noModelFlags });
await preset.answer({ kind: "effort", effort: "low" });
await preset.answer({ kind: "preset", name: "big" });
result.presetSwitch = {
  preset: pauseData(preset).preset,
  mainModel: pauseData(preset).models.main?.model,
  // The preset is applied whole: its effort replaces the session's choice.
  effort: pauseData(preset).effort,
};
// A local preset, where the process cannot host a local model.
await preset.answer({ kind: "preset", name: "mine" });
const localNotice = eventsOf(preset, "session.notice").pop();
result.localPresetWhereNoneCanRun = {
  level: localNotice?.level,
  text: localNotice?.text,
  presetKept: pauseData(preset).preset,
  mainModelKept: pauseData(preset).models.main?.model,
};

// A model named with the provider a person sees. The agent runs every
// OpenAI model through its `openai-responses` client, and reports that.
process.env.OPENAI_API_KEY = "test-key";
const plain = await startSession({ models: noModelFlags });
result.fixedProviderWithNoPreset = pauseData(plain).fixedProvider;
// A model spec that names a local provider is refused too.
const mainBeforeLocalSpec = pauseData(plain).models.main?.model;
await plain.answer({ kind: "model", spec: "mlx/some-local-model" });
const localSpecNotice = eventsOf(plain, "session.notice").pop();
result.localProviderInAModelSpec = {
  level: localSpecNotice?.level,
  text: localSpecNotice?.text,
  mainModelKept: pauseData(plain).models.main?.model === mainBeforeLocalSpec,
};

await plain.answer({ kind: "model", spec: "openai/gpt-4o" });
result.publicProviderName = {
  model: pauseData(plain).models.main?.model,
  provider: pauseData(plain).models.main?.provider,
};
// A preset that names a provider fixes it. The spec is then read whole, as
// a model of that provider, which is how an OpenRouter model keeps its
// slash. The pause says so, so a front-end knows which it will get.
await preset.answer({ kind: "model", spec: "openai/gpt-4o" });
result.specUnderAFixedProvider = {
  fixedProvider: pauseData(preset).fixedProvider,
  model: pauseData(preset).models.main?.model,
  provider: pauseData(preset).models.main?.provider,
};
rmSync(settingsFile);

// A provider found from its API key fixes nothing. OpenRouter's own model
// names hold a slash, so on an OpenRouter session `z-ai/glm-5.2` is one of
// its models, not an unknown provider. (`groq/llama-3` on the anthropic
// session above is still refused.)
const keysBefore = {};
for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) {
  keysBefore[name] = process.env[name];
  delete process.env[name];
}
process.env.OPENROUTER_API_KEY = "test-key";
const routed = await startSession({ models: noModelFlags });
const noticesBeforeSlash = eventsOf(routed, "session.notice").length;
await routed.answer({ kind: "model", spec: "z-ai/glm-5.2" });
result.slashModelOnOpenRouter = {
  fixedProvider: pauseData(routed).fixedProvider,
  model: pauseData(routed).models.main?.model,
  provider: pauseData(routed).models.main?.provider,
  errors: eventsOf(routed, "session.notice")
    .slice(noticesBeforeSlash)
    .filter((notice) => notice.level === "error").length,
};
delete process.env.OPENROUTER_API_KEY;
for (const [name, value] of Object.entries(keysBefore)) {
  if (value !== undefined) process.env[name] = value;
}

writeFileSync("__result.json", JSON.stringify(result, null, 2));
process.exit(0);
