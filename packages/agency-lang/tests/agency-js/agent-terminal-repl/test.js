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
const typed = async (line, ms) => {
  child.stdin.write(`${line}\n`);
  await wait(ms);
};

await wait(4000);
await typed("hello there", 4000);
await typed("/rename smoke test", 2000);
await typed("/cost", 1000);
// Esc while the model works: the turn is dropped, and the next message
// tells the model so.
await typed("take your time", 1500);
child.stdin.write("\u001b");
await wait(3000);
const beforeNext = printed.length;
await typed("are you there", 7000);
const afterEsc = stripAnsi(printed.slice(beforeNext));
await typed("/exit", 2000);
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
