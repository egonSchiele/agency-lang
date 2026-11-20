// `agency agent`'s REPL running its session through the session core: a
// line gets its reply, `/rename` and `/cost` work against the session, and
// the session is saved where `--resume` finds it.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "agent-terminal-repl-home-"));
// A saved policy, so the first launch does not ask which one to use.
writeFileSync(path.join(home, "policy.json"), "{}");

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

const child = spawn(process.execPath, ["./stage.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    AGENCY_AGENT_HOME: home,
    ANTHROPIC_API_KEY: "test-key",
    NO_COLOR: "1",
  },
});
const exited = new Promise((resolve) => child.on("exit", resolve));
let printed = "";
child.stdout.on("data", (chunk) => {
  printed += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  printed += chunk.toString();
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const type = (line) => child.stdin.write(`${line}\n`);

// Each step waits for what the one before it prints, not for a fixed time:
// a line typed while a turn is still running is not read as a command, and
// a slow machine makes any fixed wait too short. A step that never prints
// its text gives up after LIMIT_MS, and the fixture then says which.
const LIMIT_MS = 30000;
const POLL_MS = 100;
/** Waits until what was printed after `from` holds `text`. */
async function printedSince(from, text) {
  const deadline = Date.now() + LIMIT_MS;
  while (Date.now() < deadline && !stripAnsi(printed.slice(from)).includes(text)) {
    await wait(POLL_MS);
  }
}
/** Waits until something was printed and nothing more came for a second:
 *  the header is up and the prompt is waiting. */
async function started() {
  const deadline = Date.now() + LIMIT_MS;
  let seen = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (printed.length !== seen) {
      seen = printed.length;
      quietSince = Date.now();
    } else if (seen > 0 && Date.now() - quietSince >= 1000) {
      return;
    }
    await wait(POLL_MS);
  }
}

await started();
type("hello there");
await printedSince(0, "stub reply");
type("/rename smoke test");
await printedSince(0, "Session renamed: smoke test");
type("/cost");
await printedSince(0, "Cost:");
// Esc while the model works: the turn is dropped, and the next message
// tells the model so. The scripted model takes four seconds over this
// message, so Esc after one and a half lands in the middle of the turn.
const beforeEsc = printed.length;
type("take your time");
await wait(1500);
child.stdin.write("\u001b");
await printedSince(beforeEsc, "cancelled");
const beforeNext = printed.length;
type("are you there");
await printedSince(beforeNext, "noted the cancel");
const afterEsc = stripAnsi(printed.slice(beforeNext));
type("/exit");
await printedSince(beforeNext, "Goodbye!");
child.stdin.end();
await Promise.race([exited, wait(5000)]);
child.kill();

const shown = stripAnsi(printed);
const sessionsDir = path.join(home, "sessions");
const folders = readdirSync(sessionsDir);
const records = folders.flatMap((folder) =>
  readdirSync(path.join(sessionsDir, folder))
    .filter((file) => file.endsWith(".meta.json"))
    .map((file) => JSON.parse(readFileSync(path.join(sessionsDir, folder, file), "utf8"))),
);

// Started with `--policy minimal` and closed before any turn: the session
// is never saved, so the policy file it was started with is gone too.
const policiesDir = path.join(home, "session-policies");
const closedAtOnce = spawn(process.execPath, ["./stage.js"], {
  stdio: ["pipe", "ignore", "ignore"],
  env: {
    ...process.env,
    AGENCY_AGENT_HOME: home,
    ANTHROPIC_API_KEY: "test-key",
    NO_COLOR: "1",
    STAGE_FLAGS: "--policy minimal",
  },
});
const closedExited = new Promise((resolve) => closedAtOnce.on("exit", resolve));
await wait(4000);
closedAtOnce.stdin.write("/exit\n");
await Promise.race([closedExited, wait(5000)]);
closedAtOnce.kill();
const policyFilesLeft = existsSync(policiesDir) ? readdirSync(policiesDir) : [];
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      replied: shown.includes("stub reply"),
      renamed: shown.includes("Session renamed: smoke test"),
      cost: /Cost:\s+\$0\.00\d\d/.test(shown),
      nextMessageCarriesTheNote: afterEsc.includes("noted the cancel"),
      goodbye: shown.includes("Goodbye!"),
      policyFilesLeft,
      saved: records.map((record) => ({
        title: record.title,
        turns: record.turns,
        runFormat: record.runFormat,
        heldBy: record.heldBy?.frontEnd,
      })),
    },
    null,
    2,
  ),
);
if (!shown.includes("Goodbye!")) {
  console.error(shown.slice(-3000));
}
