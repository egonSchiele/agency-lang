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
// shipped files. The agent home's learned skills and tools, which only
// enter those directories through a review interrupt. All three are
// placeholders the matcher expands at match time (`.` to the process cwd,
// `<agency>` to the package root, `<agent-home>` to the agent home, see
// docs/dev/agents/approval-policies.md), so a saved copy of this policy
// keeps meaning "wherever the agent runs, wherever agency is installed
// now". Reads anywhere else fall through: a prompt in an interactive
// session, an automatic rejection in a headless one.
export function readScopeRules(): PolicyRule[] {
  return [
    { match: { dir: "{.,./**}" }, action: "approve" },
    { match: { dir: `{${INSTALL}/stdlib/**,${INSTALL}/dist/**}` }, action: "approve" },
    {
      match: {
        dir: `{${AGENT_HOME}/skills,${AGENT_HOME}/skills/**,${AGENT_HOME}/tools,${AGENT_HOME}/tools/**}`,
      },
      action: "approve",
    },
  ];
}

// runTool's use count in a tool's meta.json. An effect of its own, never
// a std::write rule on the file; docs/dev/agents/approval-policies.md
// says why.
function toolboxRecordUseRules(): PolicyRule[] {
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
  "std::read": readScopeRules(),
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
  "std::toolbox::recordUse": toolboxRecordUseRules(),
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
    "std::mkdir": dirRule,
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

// Approve EVERY interrupt, no scoping. Use ONLY in a disposable sandbox.
export const approveAllPolicy: Policy = {
  "*": [{ action: "approve" }],
};

// Built-in names accepted by `--policy` (anything else is a file path),
// in display order with a one-line description each.
export const BUILTIN_POLICIES: { name: string; description: string }[] = [
  {
    name: "recommended",
    description:
      "Auto-approve reads under the current directory, the agency install's own docs and skills, and the agent home's learned skills and tools (plus the toolbox use count there), and web/search; prompt for reads elsewhere, writes, shell, and git changes.",
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
      "Approve EVERY interrupt — reads, writes, shell, git, anywhere, no scoping. UNSAFE outside a disposable sandbox.",
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
