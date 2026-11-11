import { setWide, oneEffect, readOnce, twoListings } from "./agent.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { safeDeleteDirectoryWithin } from "../../../dist/lib/utils.js";

const tempRoot = realpathSync(tmpdir());
// The payloads carry real paths, so the folder is named by its real path.
const root = realpathSync(mkdtempSync(join(tempRoot, "cli-policy-set-")));
mkdirSync(join(root, ".w", "a", ".build"), { recursive: true });
mkdirSync(join(root, ".w", "b"), { recursive: true });
writeFileSync(join(root, ".w", "a", ".build", "x.txt"), "needle\n");
const globFolder = join(root, "a{b}c*");
const sibling = join(root, "abc");
mkdirSync(globFolder);
mkdirSync(sibling);

// Escaped the way escapeGlob in lib/runtime/policy.ts escapes a pinned value.
const escapeGlob = (s) => s.replace(/[\\*?{}()[\]!@+|,^$"]/g, "\\$&");

// Each case runs a node with its own answers and its own policy file.
async function run(node, name, answers, args, startPolicy) {
  const policyFile = join(root, `${name}.json`);
  if (startPolicy !== undefined) {
    writeFileSync(policyFile, JSON.stringify(startPolicy));
  }
  const queue = [...answers];
  let error = null;
  let outcomes = null;
  try {
    const result = await node({ policyFile, ...args }, {
      inputOverride: async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("Unexpected extra input() call");
        return next;
      },
    });
    outcomes = result.data;
  } catch (e) {
    error = String(e);
  }
  const saved = existsSync(policyFile) ? JSON.parse(readFileSync(policyFile, "utf8")) : null;
  return { outcomes, remainingAnswers: queue.length, error, saved };
}

const READ_SET = ["std::read", "std::readBinary", "std::ls", "std::glob", "std::grep", "std::vision"];
const parentRule = (folder) => ({
  match: { dir: `{${escapeGlob(folder)},${escapeGlob(folder)}/**}` },
  action: "approve",
  matchDotFolders: true,
});

try {
  // "as" at the read prompt, then folder 3 at the folder step. The folders
  // listed are <root>/.w/a/.build, <root>/.w/a, <root>/.w, and so on.
  const set = await run(setWide, "set", ["as", "3"], { root });
  const setRule = parentRule(join(root, ".w"));

  // "ap" at the ls of <root>/.w/a, then folder 2, <root>/.w. The read below
  // it prompts and is answered "a".
  const one = await run(oneEffect, "one", ["ap", "2", "a"], { root });

  // "as", then back, then approve once: nothing is saved.
  const back = await run(readOnce, "back", ["as", "b", "a"], { root });

  // A rule for a folder named with glob characters. The sibling folder
  // "abc" must still prompt, and is answered "a".
  const glob = await run(twoListings, "glob", ["ap", "1", "a"], {
    first: globFolder,
    second: sibling,
  });

  // The policy already rejects std::glob, so "as" saves nothing under it.
  const rejected = await run(readOnce, "rejected", ["as", "1"], { root }, {
    "std::glob": [{ action: "reject" }],
  });

  // The policy rejects listing <root>/.w/b. "as" for the parent <root>/.w
  // must not overturn that: the ls is rejected without a prompt.
  const lsB = escapeGlob(join(root, ".w", "b"));
  const scopedReject = await run(setWide, "scoped-reject", ["as", "3"], { root }, {
    "std::ls": [{ match: { dir: `{${lsB},${lsB}/**}` }, action: "reject" }],
  });

  writeFileSync("__result.json", JSON.stringify({
    scopedReject: {
      outcomes: scopedReject.outcomes,
      remainingAnswers: scopedReject.remainingAnswers,
      error: scopedReject.error,
      lsRuleOrder: (scopedReject.saved?.["std::ls"] ?? []).map((rule) => rule.action),
    },
    set: {
      outcomes: set.outcomes,
      remainingAnswers: set.remainingAnswers,
      error: set.error,
      ruleUnderEveryMember: READ_SET.every(
        (effect) => JSON.stringify(set.saved?.[effect]?.[0]) === JSON.stringify(setRule),
      ),
    },
    one: {
      outcomes: one.outcomes,
      remainingAnswers: one.remainingAnswers,
      error: one.error,
      savedEffects: Object.keys(one.saved ?? {}),
      lsRule: JSON.stringify(one.saved?.["std::ls"]) === JSON.stringify([parentRule(join(root, ".w"))]),
    },
    back: {
      outcomes: back.outcomes,
      remainingAnswers: back.remainingAnswers,
      error: back.error,
      saved: back.saved,
    },
    glob: {
      outcomes: glob.outcomes,
      remainingAnswers: glob.remainingAnswers,
      error: glob.error,
    },
    rejected: {
      outcomes: rejected.outcomes,
      remainingAnswers: rejected.remainingAnswers,
      error: rejected.error,
      globRules: rejected.saved?.["std::glob"],
      readRuleSaved: rejected.saved?.["std::read"]?.length === 1,
    },
  }, null, 2));
} finally {
  safeDeleteDirectoryWithin(tempRoot, root);
}
