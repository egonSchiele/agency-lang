import {
  AGENCY_INSTALL_DIR_PLACEHOLDER as INSTALL,
  AGENT_HOME_PLACEHOLDER as AGENT_HOME,
  type Policy,
  type PolicyRule,
  escapeGlob,
} from "./policy.js";

// Read-only `agency` subcommands the code agent runs via its exec-based
// `agencyCli` tool. Matched on command + subcommand (no shell chaining);
// other subcommands (run, compile, ...) still prompt.
const AGENCY_SAFE_SUBCOMMANDS = [
  "parse",
  "ast",
  "typecheck",
  "tc",
  "help",
  "preprocess",
  "definition",
  "diagnostics",
  "doc",
  "effects",
  "literate",
];

function agencyExecApproveRules(): PolicyRule[] {
  return AGENCY_SAFE_SUBCOMMANDS.map((sub) => ({
    match: { command: "agency", subcommand: sub },
    action: "approve" as const,
  }));
}

const approve: PolicyRule[] = [{ action: "approve" }];

// Where the read-only file tools may look without asking. The launch
// directory. The agency install itself, because the agent's docs tools
// (`agencyGuide` and friends) and bundled skills are plain reads of
// shipped files. Three directories of the agent home: the skills and
// tools it has learned, and its memory.
//
// The home as a whole is deliberately not in scope. `sessions/` and
// `history` hold earlier conversations, often from other projects, and
// these rules also cover `std::grep`, `std::glob`, and `std::ls`, which
// search a whole tree. With the home in scope, text injected into one
// project could have the agent grep every earlier conversation and put
// what it found into a web search, which this same policy approves, and
// the user would not be asked at any step.
//
// All of these are placeholders the matcher expands at match time
// (`.` to the process cwd, `<agency>` to the package root,
// `<agent-home>` to the agent home, see
// docs/dev/agents/approval-policies.md), so a saved copy of this policy
// keeps meaning "wherever the agent runs, wherever agency is installed
// now". Reads anywhere else fall through: a prompt in an interactive
// session, an automatic rejection in a headless one.
const AGENT_HOME_READ_DIRS = ["skills", "tools", "memory"]
  .flatMap((name) => [`${AGENT_HOME}/${name}`, `${AGENT_HOME}/${name}/**`])
  .join(",");

export function readScopeRules(): PolicyRule[] {
  return [
    { match: { dir: "{.,./**}" }, action: "approve" },
    { match: { dir: `{${INSTALL}/stdlib/**,${INSTALL}/dist/**}` }, action: "approve" },
    { match: { dir: `{${AGENT_HOME_READ_DIRS}}` }, action: "approve" },
  ];
}

// The agent's own settings file, read by name. Only `std::read` gets it:
// the tree-searching effects carry no filename, so a rule that names one
// cannot match them.
//
// Writing it is left to the prompt on purpose. settings.json decides
// what the next agent start runs: an `mcpServers` entry is a command,
// which `maybeLoadMcp` hands to the mcp package and the next start
// spawns, and `loadSettings` does not sanitize that field. A rule
// approving the write would let text injected into one project write
// the agent a command to run, with the user asked at no step. `/model`
// and `/preset` therefore ask before they save, like any other write.
//
// Three things beside the file are the same kind of hole, which is why
// no rule covers the directory either:
//
//   - policy.json and session-policy.json. They are this policy. An
//     agent that can rewrite them can grant itself anything.
//   - skills/**. A skill enters through `designSkill`'s review.
//   - tools/**. Same, through the toolbox's review and save gates.
function settingsReadRule(): PolicyRule[] {
  return [{ match: { dir: AGENT_HOME, filename: "settings.json" }, action: "approve" }];
}

// The toolbox working in its own directories under the agent home:
// runTool's use count in a tool's meta.json, the staging directory a
// draft is built in, and the draft's own files. Each is an effect of its
// own, never a std::write or std::mkdir rule on the file;
// docs/dev/agents/approval-policies.md says why. The draft's files are
// approved because writing them decides nothing: the user sees the
// finished draft at std::toolbox::review and says yes or no to it at
// std::toolbox::save, and both of those are left to the prompt.
function toolboxHousekeepingRules(): PolicyRule[] {
  return [{ match: { dir: `${AGENT_HOME}/tools/**` }, action: "approve" }];
}

export const minimalAutoApprovePolicy: Policy = {
  "std::memory::remember": approve,
  "std::memory::forget": approve,
  "std::memory::recall": approve,
  "std::memory::enableMemory": approve,
  "std::memory::disableMemory": approve,
  "std::exec": agencyExecApproveRules(),
};

export const recommendedAutoApprovePolicy: Policy = {
  ...minimalAutoApprovePolicy,
  // A sandboxed subprocess: the code it runs raises its own effects back
  // through this same policy, so approving the launch grants nothing more.
  "std::run": approve,
  // Long command output, saved to and read back from the spill directory
  // (`std::spill`). The write goes to one fixed place the model cannot
  // choose, and the read tools take a file name, never a path.
  "std::spill::write": approve,
  "std::spill::read": approve,
  // `writeSettingsFile` creates the agent home when it is missing. An
  // empty directory decides nothing, and the write into it still asks.
  "std::mkdir": [{ match: { dir: AGENT_HOME }, action: "approve" }],
  "std::read": [...readScopeRules(), ...settingsReadRule()],
  "std::readBinary": readScopeRules(),
  "std::ls": readScopeRules(),
  "std::glob": readScopeRules(),
  "std::grep": readScopeRules(),
  "std::wikipedia::search": approve,
  "std::wikipedia::summary": approve,
  "std::wikipedia::article": approve,
  "std::weather": approve,
  "std::search": approve,
  "std::tavilySearch": approve,
  // A scan reads every skill, command, or tool file under a directory,
  // so it takes the read scope.
  "std::skills::skillsDir": readScopeRules(),
  "std::skills::commandsDir": readScopeRules(),
  "std::toolbox::scan": readScopeRules(),
  "std::toolbox::recordUse": toolboxHousekeepingRules(),
  "std::toolbox::writeFile": toolboxHousekeepingRules(),
  "std::toolbox::createStaging": toolboxHousekeepingRules(),
  "std::toolbox::removeStaging": toolboxHousekeepingRules(),
  "std::toolbox::removeStagedFile": toolboxHousekeepingRules(),
  "std::notify": approve,
  "std::clipboardCopy": approve,
  "std::git::status": approve,
  "std::git::log": approve,
  "std::git::diff": approve,
  "std::git::show": approve,
  "std::git::branchList": approve,
  "std::git::remoteList": approve,
  "std::git::blame": approve,
  "std::git::stashList": approve,
  // GitHub reads through the user's own token: the same class of action as
  // the git reads above and the web lookups. Every std::github write is left
  // out, so it prompts the way std::git::commit and std::write do.
  "std::github::prGet": approve,
  "std::github::prList": approve,
  "std::github::prDiff": approve,
  "std::github::prFiles": approve,
  "std::github::prReviewList": approve,
  "std::github::prReviewCommentList": approve,
  "std::github::prChecks": approve,
  "std::github::issueGet": approve,
  "std::github::issueList": approve,
  "std::github::issueCommentList": approve,
  "std::github::issueSearch": approve,
};

// Glob matching a directory and everything under it — same convention
// std::policy's buildScopedMatch uses for "approve-always-here". `baseDir` is
// escaped so only the brace/`**` in THIS pattern are treated as globs.
function dirScope(baseDir: string): string {
  const b = escapeGlob(baseDir);
  return `{${b},${b}/**}`;
}

// `recommended` plus mutating file-system and git-write effects, each
// scoped to `baseDir` and its children. Matched on each effect's path
// field: `dir` (write/edit/mkdir), `target` (remove), `src`+`dest`
// (copy/move), `cwd` (git).
export function withWritesPolicy(baseDir: string): Policy {
  const scope = dirScope(baseDir);
  const dirRule: PolicyRule[] = [{ match: { dir: scope }, action: "approve" }];
  const cwdRule: PolicyRule[] = [{ match: { cwd: scope }, action: "approve" }];
  return {
    ...recommendedAutoApprovePolicy,
    "std::write": dirRule,
    "std::writeBinary": dirRule,
    "std::edit": dirRule,
    "std::mkdir": [{ match: { dir: AGENT_HOME }, action: "approve" }, ...dirRule],
    "std::remove": [{ match: { target: scope }, action: "approve" }],
    "std::copy": [{ match: { src: scope, dest: scope }, action: "approve" }],
    "std::move": [{ match: { src: scope, dest: scope }, action: "approve" }],
    "std::git::add": cwdRule,
    "std::git::commit": cwdRule,
    "std::git::checkout": cwdRule,
    "std::git::switch": cwdRule,
    "std::git::branchCreate": cwdRule,
    "std::git::branchDelete": cwdRule,
    "std::git::stashPush": cwdRule,
    "std::git::stashPop": cwdRule,
    "std::git::restore": cwdRule,
  };
}

// Approve every interrupt, no scoping, except a raise that asks for a
// value — no rule can answer one of those, whatever it says (see
// `isOwnPolicyIo`'s neighbours in stdlib/policy.agency). Use ONLY in a
// disposable sandbox.
export const approveAllPolicy: Policy = {
  "*": [{ action: "approve" }],
};

// Built-in names accepted by `--policy` (anything else is a file path),
// in display order with a one-line description each.
export const BUILTIN_POLICIES: { name: string; description: string }[] = [
  {
    name: "recommended",
    description:
      "Auto-approve reads under the current directory, the agency install's own docs and skills, and the agent home's learned skills, tools, and memory (plus the toolbox's own drafting and use-count files there), web/search, and the agent reading its own settings.json; prompt for reads elsewhere, every write, shell, and git changes.",
  },
  {
    name: "minimal",
    description:
      "Auto-approve only memory and the safe read-only agency subcommands; prompt for everything else.",
  },
  {
    name: "with-writes",
    description:
      "recommended + auto-approve file writes and git changes, scoped to the current directory and its children.",
  },
  {
    name: "approve-all",
    description:
      "Approve EVERY interrupt — reads, writes, shell, git, anywhere, no scoping. A raise that asks for a value (a question, a draft to review) still goes to the user, because an approval from a rule carries no answer. UNSAFE outside a disposable sandbox.",
  },
];

export function builtinPolicyNames(): string[] {
  return BUILTIN_POLICIES.map((p) => p.name);
}

// Resolve a built-in name to a concrete Policy, scoping cwd-relative
// variants to `baseDir`. Returns null for an unknown name so the caller
// can fall back to treating the argument as a file path.
export function builtinPolicy(name: string, baseDir: string): Policy | null {
  if (name === "minimal") return minimalAutoApprovePolicy;
  if (name === "recommended") return recommendedAutoApprovePolicy;
  if (name === "with-writes") return withWritesPolicy(baseDir);
  if (name === "approve-all") return approveAllPolicy;
  return null;
}
