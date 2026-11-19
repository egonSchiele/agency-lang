// A session run is started in a process that also loaded the terminal
// agent's modules (agent.js pulls in all of them, trace.agency among them).
// A second process, which loads only the session program, resumes the saved
// pause and sends a second message. The checkpoint must not need the
// terminal's modules.
//
// This file is both processes: the second is started with RESUME set.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROGRAM = "../../../dist/lib/agents/agency-agent/program.js";
const TERMINAL = "../../../dist/lib/agents/agency-agent/agent.js";
const policy = { "agent::sessionInput": [{ action: "propagate" }] };
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };
const message = (text) => ({ kind: "message", text, notes: [], target: "" });

function installClient(setClient) {
  setClient({
    async text() {
      return {
        success: true,
        value: { output: "stub reply", toolCalls: [], model: "test", usage: USAGE, cost: COST },
      };
    },
    async *textStream(config) {
      const response = await this.text(config);
      yield { type: "done", result: response.value };
    },
    async embed() {
      throw new Error("Unexpected embedding request");
    },
  });
}

function startData(project) {
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
    },
  };
}

const totalTokens = (result) => result?.usage?.tokens?.totalTokens ?? 0;

async function startAndPause() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "foreign-modules-"));
  process.env.AGENCY_AGENT_HOME = mkdtempSync(path.join(os.tmpdir(), "foreign-home-"));
  process.env.ANTHROPIC_API_KEY = "test-key";
  const project = mkdtempSync(path.join(os.tmpdir(), "foreign-project-"));

  // Loads every terminal module. Only the import matters; nothing is run.
  await import(TERMINAL);
  const program = await import(PROGRAM);
  installClient(program.__setLLMClient);

  const started = await program.main(startData(project), { policy });
  const paused = await program.respondToInterrupts(
    started.data,
    [program.approve(message("first message"))],
    { invocation: { policy } },
  );
  const pauseFile = path.join(scratch, "pause.json");
  const resultFile = path.join(scratch, "second.json");
  writeFileSync(pauseFile, JSON.stringify(paused.data));
  const pauseBytes = statSync(pauseFile).size;
  const firstTotal = totalTokens(paused);

  execFileSync(process.execPath, ["./test.js"], {
    stdio: "inherit",
    env: {
      ...process.env,
      RESUME: "1",
      PAUSE_FILE: pauseFile,
      RESULT_FILE: resultFile,
    },
  });
  const second = JSON.parse(readFileSync(resultFile, "utf8"));
  console.error(
    `pause file: ${pauseBytes} bytes; usage totalTokens first=${firstTotal} second=${second.total}`,
  );
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        secondProcessReplied: second.replies.includes("stub reply"),
        secondProcessError: second.error,
        usageCarriedOver: second.total >= firstTotal && firstTotal > 0,
      },
      null,
      2,
    ),
  );
}

async function resume() {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const program = await import(PROGRAM);
  installClient(program.__setLLMClient);
  const pause = JSON.parse(readFileSync(process.env.PAUSE_FILE, "utf8"));
  const emitted = [];
  const callbacks = { onEmit: (event) => void emitted.push(event) };
  let error = "";
  let total = 0;
  try {
    const next = await program.respondToInterrupts(
      pause,
      [program.approve(message("second message"))],
      { metadata: { callbacks }, invocation: { policy } },
    );
    total = totalTokens(next);
    if (!program.hasInterrupts(next.data)) error = String(next.data?.error ?? "the run ended");
  } catch (caught) {
    error = String(caught?.stack ?? caught);
  }
  const replies = emitted
    .filter((event) => event.type === "session.reply")
    .map((event) => event.text);
  writeFileSync(process.env.RESULT_FILE, JSON.stringify({ replies, error, total }));
}

if (process.env.RESUME) {
  await resume();
} else {
  await startAndPause();
}
process.exit(0);
