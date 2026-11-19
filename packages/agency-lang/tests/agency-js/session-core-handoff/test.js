// One process starts a session and pauses in the middle of a turn, on an
// approval. A second process, which never ran `main`, approves it and
// finishes the turn. Both load the program through the package export,
// as two front-ends would.
//
// This file is both processes: the second is started with RESUME set.
// (Only test.js is kept in git under tests/, so there is no second file.)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCall } from "smoltalk";

const PAUSE = "agent::sessionInput";
const policy = { [PAUSE]: [{ action: "propagate" }] };
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 };
const COST = { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" };

const reply = (output, toolCalls = []) => ({
  success: true,
  value: { output, toolCalls, model: "test", usage: USAGE, cost: COST },
});

// The test client. It answers by what the request holds, not by a call
// count, so the process that resumes needs no state from the one that
// paused.
function installClient(setClient, noteDir) {
  setClient({
    async text(config) {
      const hasTools = (config.tools ?? []).length > 0;
      // The read's result, with the file's text in it: a rejected or a
      // failed read also leaves a tool message, and must not count.
      const readDone = config.messages.some(
        (message) => message.role === "tool" && JSON.stringify(message.content).includes("a note"),
      );
      const readTried = config.messages.some((message) => message.role === "tool");
      // The session title is asked for with no tools.
      if (!hasTools) return reply("A title");
      if (readDone) return reply("stub reply after the read");
      if (readTried) return reply("the read did not return the note");
      return reply(null, [new ToolCall("call-1", "read", { filename: "note.txt", dir: noteDir })]);
    },
    async *textStream(config) {
      const response = await this.text(config);
      yield { type: "done", result: response.value };
    },
    async embed() {
      throw new Error("Unexpected embedding request in the handoff test");
    },
  });
}

// The terminal front-end's modules. None may be on the saved stack.
const TERMINAL =
  /agency-agent\/(agent|lib\/(repl|capabilitiesUi|mcpMenu|header|transcript|args|policy|trace|runSession|resume|slashCommands\/[^.]+))\.agency$/;

/** The first process: start a session and pause on the read's approval. */
async function startAndPause() {
  // The agent home is read when the modules load, so it is set first.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "session-handoff-"));
  process.env.AGENCY_AGENT_HOME = mkdtempSync(path.join(os.tmpdir(), "handoff-home-"));
  process.env.ANTHROPIC_API_KEY = "test-key";
  const project = mkdtempSync(path.join(os.tmpdir(), "handoff-project-"));
  // A folder outside the project, so the read is one no rule decides.
  const noteDir = mkdtempSync(path.join(os.tmpdir(), "handoff-notes-"));
  writeFileSync(path.join(noteDir, "note.txt"), "a note");

  const program = await import("agency-lang/agent-session");
  installClient(program.__setLLMClient, noteDir);

  const started = await program.main(
    {
      brain: "minimal",
      preset: "",
      models: { pin: "claude-sonnet-4-6", slots: {}, provider: "", local: null, effort: null },
      limits: { maxToolCallRounds: null, maxToolResultChars: null },
      session: {
        cwd: project,
        replyStyle: "",
        record: {
          id: "s1",
          cwd: project,
          brain: "",
          created: 1,
          lastActive: 1,
          turns: 0,
          title: "",
        },
        flags: null,
      },
    },
    { policy },
  );
  const paused = await program.respondToInterrupts(
    started.data,
    [program.approve({ kind: "message", text: "read the note", notes: [], target: "" })],
    { invocation: { policy } },
  );
  const approval = paused.data;
  const modules = approval.flatMap((interrupt) =>
    Object.keys(interrupt.checkpoint?.moduleFingerprints ?? {}),
  );

  // What a front-end saves: the interrupts, each with its checkpoint.
  const pauseFile = path.join(scratch, "pause.json");
  const resumedFile = path.join(scratch, "resumed.json");
  writeFileSync(pauseFile, JSON.stringify(approval));
  execFileSync(process.execPath, ["./test.js"], {
    stdio: "inherit",
    env: {
      ...process.env,
      RESUME: "1",
      NOTE_DIR: noteDir,
      PAUSE_FILE: pauseFile,
      RESUMED_FILE: resumedFile,
    },
  });
  const resumed = JSON.parse(readFileSync(resumedFile, "utf8"));

  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        pausedOn: approval.map((interrupt) => interrupt.effect),
        pauseHoldsTheCore: modules.some((id) => id.endsWith("agency-agent/core.agency")),
        pauseModulesHoldNoTerminalCode: !modules.some((id) => TERMINAL.test(id)),
        ...resumed,
      },
      null,
      2,
    ),
  );
}

/** The second process: load the program, never call `main`, and answer
 *  the approval the first process paused on. */
async function resume() {
  const program = await import("agency-lang/agent-session");
  installClient(program.__setLLMClient, process.env.NOTE_DIR);

  const pause = JSON.parse(readFileSync(process.env.PAUSE_FILE, "utf8"));
  const emitted = [];
  const next = await program.respondToInterrupts(pause, [program.approve()], {
    metadata: { callbacks: { onEmit: (event) => void emitted.push(event) } },
    invocation: { policy },
  });
  const paused = program.hasInterrupts(next.data);
  const data = paused ? next.data[0].data : null;

  writeFileSync(
    process.env.RESUMED_FILE,
    JSON.stringify({
      reply: emitted.filter((event) => event.type === "session.reply").map((event) => event.text),
      nextPauseEffect: paused ? next.data[0].effect : "the run ended",
      turnsAfterResume: data?.record?.turns,
      brainAfterResume: data?.record?.brain,
      mainModelAfterResume: data?.models?.main?.model,
    }),
  );
}

if (process.env.RESUME) {
  await resume();
} else {
  await startAndPause();
}
process.exit(0);
