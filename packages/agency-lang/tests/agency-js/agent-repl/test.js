// `agency agent`'s REPL, typed into, with a scripted model.
//
// The first sitting: a line gets its reply, `/rename` and `/cost` work,
// Esc cancels a turn, a write no rule covers is asked about and done, and
// the session is saved where `--continue` finds it.
//
// The second sitting is closed while an approval is on screen. The third
// continues the session, is asked the same approval without anything
// typed, and finishes that turn.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "agent-repl-home-"));
const notes = mkdtempSync(path.join(os.tmpdir(), "agent-repl-notes-"));
// A saved policy with no rules, so the first launch does not ask which one
// to use and the write is covered by none. A saved search choice, so no
// note about picking one is printed.
writeFileSync(path.join(home, "policy.json"), "{}");
writeFileSync(path.join(home, "settings.json"), JSON.stringify({ search: { backend: "hosted" } }));

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each step waits for what the one before it prints, not for a fixed time:
// a line typed while a turn is still running is not read as a command, and
// a slow machine makes any fixed wait too short. A step that never prints
// its text gives up after LIMIT_MS, and the fixture then says which.
const LIMIT_MS = 30000;
const POLL_MS = 100;

/** One sitting: `agency agent` with `flags`, typed into. */
function sitting(flags, stdio = ["pipe", "pipe", "pipe"]) {
  const child = spawn(process.execPath, ["./stage.js"], {
    stdio,
    env: {
      ...process.env,
      AGENCY_AGENT_HOME: home,
      ANTHROPIC_API_KEY: "test-key",
      NO_COLOR: "1",
      NOTE_DIR: notes,
      STAGE_FLAGS: flags,
    },
  });
  const state = { child, printed: "", exited: new Promise((resolve) => child.on("exit", resolve)) };
  child.stdout?.on("data", (chunk) => (state.printed += chunk.toString()));
  child.stderr?.on("data", (chunk) => (state.printed += chunk.toString()));
  return state;
}

/** Waits until what was printed after `from` holds `text`. Says whether
 *  it did. */
async function printedSince(state, from, text) {
  const deadline = Date.now() + LIMIT_MS;
  while (Date.now() < deadline && !stripAnsi(state.printed.slice(from)).includes(text)) {
    await wait(POLL_MS);
  }
  return stripAnsi(state.printed.slice(from)).includes(text);
}

/** Waits until something was printed and nothing more came for a second:
 *  the header is up and the prompt is waiting. */
async function started(state) {
  const deadline = Date.now() + LIMIT_MS;
  let seen = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (state.printed.length !== seen) {
      seen = state.printed.length;
      quietSince = Date.now();
    } else if (seen > 0 && Date.now() - quietSince >= 1000) {
      return;
    }
    await wait(POLL_MS);
  }
}

const type = (state, line) => state.child.stdin.write(`${line}\n`);

async function close(state) {
  type(state, "/exit");
  const goodbye = await printedSince(state, 0, "Goodbye!");
  state.child.stdin.end();
  await Promise.race([state.exited, wait(5000)]);
  state.child.kill();
  return goodbye;
}

function savedRecords() {
  const sessionsDir = path.join(home, "sessions");
  return readdirSync(sessionsDir).flatMap((folder) =>
    readdirSync(path.join(sessionsDir, folder))
      .filter((file) => file.endsWith(".meta.json"))
      .map((file) => JSON.parse(readFileSync(path.join(sessionsDir, folder, file), "utf8"))),
  );
}

/** What the note holds, or "" when it was not written. */
function noteNow() {
  const file = path.join(notes, "note.txt");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

const record = () =>
  savedRecords().map((saved) => ({
    title: saved.title,
    turns: saved.turns,
    runFormat: saved.runFormat,
  }));

// The first sitting.
const first = sitting("");
await started(first);
type(first, "hello there");
const replied = await printedSince(first, 0, "stub reply");
type(first, "/rename smoke test");
const renamed = await printedSince(first, 0, "Session renamed: smoke test");
type(first, "/cost");
await printedSince(first, 0, "Cost:");
// Esc while the model works: the turn is cancelled. The scripted model
// takes four seconds over this message, so Esc after one and a half lands
// in the middle of the turn.
const beforeEsc = first.printed.length;
type(first, "take your time");
await wait(1500);
first.child.stdin.write("\u001b");
const cancelled = await printedSince(first, beforeEsc, "cancelled");
const beforeNext = first.printed.length;
type(first, "are you there");
const repliedAfterEsc = await printedSince(first, beforeNext, "stub reply");
// A write no rule covers: the person is asked, and approves it once.
const beforeWrite = first.printed.length;
type(first, "write the note");
const asked = await printedSince(first, beforeWrite, "approval needed");
first.child.stdin.write("a\r");
const wrote = await printedSince(first, beforeWrite, "wrote the note");
const firstNote = noteNow();
const goodbye = await close(first);
const shown = stripAnsi(first.printed);
const afterFirst = record();

// The second sitting continues the session, and is closed with an
// approval on screen.
const second = sitting("--continue");
await started(second);
const showsTheConversation = stripAnsi(second.printed).includes("hello there");
type(second, "write the note again");
const askedInSecond = await printedSince(second, 0, "approval needed");
second.child.kill("SIGKILL");
await second.exited;
const afterSecond = record();

// The third sitting continues it, and is asked the same approval with
// nothing typed.
const third = sitting("--continue");
const askedAgain = await printedSince(third, 0, "approval needed");
// The conversation printed on a resume holds an earlier "wrote the note".
const beforeAnswer = third.printed.length;
third.child.stdin.write("a\r");
const wroteAfterResume = await printedSince(third, beforeAnswer, "wrote the note");
const secondNote = noteNow();
const goodbyeAfterResume = await close(third);
const afterThird = record();

// Started with `--policy minimal` and closed before any turn: the session
// is never saved, so the policy file it was started with is gone too.
const policiesDir = path.join(home, "session-policies");
const closedAtOnce = sitting("--policy minimal", ["pipe", "ignore", "ignore"]);
await wait(4000);
closedAtOnce.child.stdin.write("/exit\n");
await Promise.race([closedAtOnce.exited, wait(5000)]);
closedAtOnce.child.kill();
const policyFilesLeft = existsSync(policiesDir) ? readdirSync(policiesDir) : [];

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      replied,
      renamed,
      cost: /Cost:\s+\$0\.00\d\d/.test(shown),
      cancelled,
      repliedAfterEsc,
      asked,
      wrote,
      firstNote,
      goodbye,
      afterFirst,
      showsTheConversation,
      askedInSecond,
      afterSecond,
      askedAgain,
      wroteAfterResume,
      secondNote,
      goodbyeAfterResume,
      afterThird,
      policyFilesLeft,
    },
    null,
    2,
  ),
);
if (!goodbye || !goodbyeAfterResume || process.env.SHOW === "1") {
  console.error("=== first ===\n" + shown.slice(-3000));
  console.error("=== second ===\n" + stripAnsi(second.printed).slice(-2000));
  console.error("=== third ===\n" + stripAnsi(third.printed).slice(-3000));
}
