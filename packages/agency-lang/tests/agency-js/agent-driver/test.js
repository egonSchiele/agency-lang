// Drives a real run through the session driver (lib/stdlib/agentDriver):
// start it, resume it, abort it, run it under policies, and save it in the
// middle of a turn and load it back. The program is agent.agency, a small
// stand-in for the agent's session program that needs no model.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fixture from "./agent.js";
import { approve } from "../../../dist/lib/runtime/index.js";
import {
  canResume,
  initialPhase,
  messageAnswer,
  readSavedRun,
  reduceDriver,
  restoredPhase,
  resumeRun,
  saveRun,
  savedRun,
  startRun,
  stopDroppedJobs,
  thisProcessId,
} from "../../../dist/lib/stdlib/agentDriver/index.js";
import { currentHost } from "../../../dist/lib/runtime/currentHost.js";
import { jobStatus } from "../../../dist/lib/runtime/jobs/detachedJobs.js";

const SLOW_ABORT_MS = 300;
const PROJECT = "/driver-test";
const RECORD = {
  id: "s1",
  cwd: PROJECT,
  brain: "",
  created: 1,
  lastActive: 1,
  turns: 0,
  title: "",
};
const START = {
  brain: "",
  preset: "",
  models: { pin: "", slots: {}, provider: "", local: null, effort: null },
  limits: { maxToolCallRounds: null, maxToolResultChars: null },
  session: {
    cwd: PROJECT,
    replyStyle: "",
    record: RECORD,
    flags: null,
    budget: { maxCost: 1, maxTime: 1 },
  },
};
const agent = {
  main: (opts) => fixture.main(START, opts),
  respondToInterrupts: fixture.respondToInterrupts,
};
const asksAll = () => null;

function recorder() {
  const emitted = [];
  return { emitted, callbacks: { onEmit: (data) => void emitted.push(data) } };
}

function stepOf(outcome) {
  if (!outcome.result.success) {
    throw new Error(`expected a step, got failure: ${outcome.result.error}`);
  }
  return outcome.result.value;
}

async function started(callbacks, policy = null) {
  return stepOf(await startRun({ agent, callbacks, policy })).interrupts;
}

function send({ pause, text, callbacks, policy = null, abortSignal }) {
  return resumeRun({
    agent,
    callbacks,
    policy,
    interrupts: pause,
    responses: [approve(messageAnswer(text))],
    abortSignal,
  });
}

async function sendUnder(policy, text) {
  const { callbacks } = recorder();
  const pause = await started(callbacks, policy);
  return send({ pause, text, callbacks, policy });
}

async function basics() {
  const { callbacks, emitted } = recorder();
  const first = await startRun({ agent, callbacks, policy: null });
  const pause = stepOf(first).interrupts;
  const replied = await send({ pause, text: "hi", callbacks });
  const asked = await send({ pause, text: "approve:x", callbacks });
  const failed = await send({ pause, text: "fail", callbacks });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), SLOW_ABORT_MS);
  const aborted = await send({ pause, text: "slow", callbacks, abortSignal: controller.signal });
  return {
    startWaits: stepOf(first).kind,
    startReportsUsage: typeof first.usage?.tokens === "object",
    messageWaitsAgain: stepOf(replied).kind,
    replyEmitted: emitted.some(
      (event) => event.type === "session.reply" && event.text === "echo: hi",
    ),
    // No policy: the run gets only the pin, and the approval reaches us.
    approvalWithNoPolicy: stepOf(asked).kind,
    approvalEffect: stepOf(asked).interrupts[0]?.effect,
    crashIsFailure: !failed.result.success && failed.result.error.includes("fixture failure"),
    abortIsCancelled: stepOf(aborted).kind,
  };
}

async function policies() {
  const approved = await sendUnder(
    { "driver::testApproval": [{ action: "approve" }] },
    "approve:x",
  );
  const rejected = await sendUnder(
    { "driver::testApproval": [{ action: "reject", rejectMessage: "no test" }] },
    "approve:x",
  );
  const noRule = await sendUnder({ "std::bash": [{ action: "approve" }] }, "approve:x");
  return {
    ruleApproves: stepOf(approved).kind,
    ruleRejects: !rejected.result.success && rejected.result.error.includes("no test"),
    noRuleAsks: stepOf(noRule).kind,
    withNoPolicyAtAll: await withoutTheDriver(),
  };
}

// The same approval, in a run given no policy at all, called without the
// driver: the driver's pin-only policy changes nothing a front-end sees.
async function withoutTheDriver() {
  const begun = await agent.main({ callbacks: {} });
  const asked = await agent.respondToInterrupts(begun.data, [approve(messageAnswer("approve:x"))], {
    metadata: { callbacks: {} },
  });
  return asked.data.map((interrupt) => interrupt.effect);
}

// The pin beats `*`: a policy that rejects everything still leaves the
// pause to us, so the session takes one message after another.
async function rejectEverything() {
  const policy = { "*": [{ action: "reject" }] };
  const { callbacks, emitted } = recorder();
  const pause = await started(callbacks, policy);
  const first = await send({ pause, text: "one", callbacks, policy });
  const second = await send({ pause: stepOf(first).interrupts, text: "two", callbacks, policy });
  const replies = emitted
    .filter((event) => event.type === "session.reply")
    .map((event) => event.text);
  return { underRejectAll: stepOf(second).kind, rejectAllReplies: replies };
}

async function leg(phase, callbacks) {
  const outcome = await resumeRun({
    agent,
    callbacks,
    policy: null,
    interrupts: phase.leg.interrupts,
    responses: phase.leg.responses,
  });
  return reduceDriver(phase, { type: "legFinished", result: outcome.result, settle: asksAll });
}

// A turn paused on an approval is saved, loaded back, approved, and
// finishes.
async function savedMidTurn() {
  const { callbacks, emitted } = recorder();
  const begun = await startRun({ agent, callbacks, policy: null });
  let step = reduceDriver(initialPhase, {
    type: "legFinished",
    result: begun.result,
    settle: asksAll,
  });
  step = reduceDriver(step.phase, { type: "submitted", text: "approve:x" });
  step = await leg(step.phase, callbacks);
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-driver-"));
  const saved = await saveRun({
    dir,
    record: RECORD,
    run: savedRun(step.phase),
    holder: { frontEnd: "test", pid: 1, processId: thisProcessId() },
  });
  const run = await readSavedRun(dir, RECORD.id);
  const loaded = restoredPhase(run);
  const interruptId = loaded.phase.queue.interrupts[0].interruptId;
  step = reduceDriver(loaded.phase, {
    type: "decided",
    response: approve(),
    interruptId,
    settle: asksAll,
  });
  step = await leg(step.phase, callbacks);
  rmSync(dir, { recursive: true, force: true });
  return {
    pausedOn: savedRun(loaded.phase)?.turn?.approvals?.[0]?.effect,
    saved: saved.success,
    loadedCanResume: canResume(run),
    loadedPhase: loaded.phase.kind,
    afterApproval: step.phase.kind,
    replyAfterLoad: emitted.some((event) => event.text === "echo: approve:x"),
  };
}

// A turn starts a job and is aborted. The leg reports the job it started,
// and stopping the dropped turn's jobs stops it.
async function abortedJob() {
  const { callbacks } = recorder();
  const pause = await started(callbacks);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1000);
  const aborted = await send({ pause, text: "job", callbacks, abortSignal: controller.signal });
  const host = currentHost();
  const jobs = aborted.startedJobs;
  const before = jobs.length === 1 ? (await jobStatus(host, jobs[0].handle.id))?.state : null;
  await stopDroppedJobs(host, jobs);
  const after = jobs.length === 1 ? (await jobStatus(host, jobs[0].handle.id))?.state : null;
  return {
    abortedLeg: stepOf(aborted).kind,
    startedJobs: jobs.length,
    jobBeforeStop: before,
    jobAfterStop: after,
  };
}

const result = {
  ...(await basics()),
  ...(await policies()),
  ...(await rejectEverything()),
  ...(await savedMidTurn()),
  ...(await abortedJob()),
};
writeFileSync("__result.json", JSON.stringify(result, null, 2));
process.exit(0);
