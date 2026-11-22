import { twoCommands, oneCommand } from "./agent.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { safeDeleteDirectoryWithin } from "../../../dist/lib/utils.js";

const tempRoot = realpathSync(tmpdir());
// The payloads carry real paths, so the folder is named by its real path.
const root = realpathSync(mkdtempSync(join(tempRoot, "cli-policy-exec-")));
const sub = join(root, "sub");
mkdirSync(sub);

// Escaped the way escapeGlob in lib/runtime/policy.ts escapes a pinned value.
const escapeGlob = (s) => s.replace(/[\\*?{}()[\]!@+|,^$"]/g, "\\$&");

// Each case runs a node with its own answers and its own policy file.
async function run(node, name, answers, args) {
  const policyFile = join(root, `${name}.json`);
  const queue = [...answers];
  let error = null;
  let outcomes = null;
  try {
    const result = await node(
      { policyFile, ...args },
      {
        inputOverride: async () => {
          const next = queue.shift();
          if (next === undefined) throw new Error("Unexpected extra input() call");
          return next;
        },
      },
    );
    outcomes = result.data;
  } catch (e) {
    error = String(e);
  }
  const saved = existsSync(policyFile) ? JSON.parse(readFileSync(policyFile, "utf8")) : null;
  return { outcomes, remainingAnswers: queue.length, error, saved };
}

// The rule "echo run …" in `root` and below saves.
const widerRule = {
  match: {
    command: "echo",
    args: ["run", "**"],
    cwd: `{${escapeGlob(root)},${escapeGlob(root)}/**}`,
  },
  action: "approve",
  matchDotFolders: true,
};
const holdsWiderRule = (saved) =>
  JSON.stringify(saved?.["std::exec"]) === JSON.stringify([widerRule]);

try {
  // "ap", then the third command choice ("echo run …"), then the second
  // folder (`root`). The second command must not prompt.
  const picks = await run(twoCommands, "picks", ["ap", "3", "2"], { dir: sub, answersOnly: false });

  // The same picks when answers are replayed into the file, which is how
  // the agent saves. The file must get the wider rule.
  const replayed = await run(twoCommands, "replayed", ["ap", "3", "2"], {
    dir: sub,
    answersOnly: true,
  });

  // "ap", then back at the command step, then approve once: the first
  // menu shows again and nothing is saved.
  const back = await run(oneCommand, "back", ["ap", "b", "a"], { dir: sub });

  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        picks: {
          outcomes: picks.outcomes,
          remainingAnswers: picks.remainingAnswers,
          error: picks.error,
          widerRule: holdsWiderRule(picks.saved),
        },
        replayed: {
          outcomes: replayed.outcomes,
          remainingAnswers: replayed.remainingAnswers,
          error: replayed.error,
          widerRule: holdsWiderRule(replayed.saved),
        },
        back: {
          outcomes: back.outcomes,
          remainingAnswers: back.remainingAnswers,
          error: back.error,
          saved: back.saved,
        },
      },
      null,
      2,
    ),
  );
} finally {
  safeDeleteDirectoryWithin(tempRoot, root);
}
