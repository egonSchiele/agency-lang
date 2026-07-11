import type { Policy, PolicyRule } from "./policy.js";

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
  "literate",
];

function agencyExecApproveRules(): PolicyRule[] {
  return AGENCY_SAFE_SUBCOMMANDS.map((sub) => ({
    match: { command: "agency", subcommand: sub },
    action: "approve" as const,
  }));
}

const approve: PolicyRule[] = [{ action: "approve" }];

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
  "std::read": approve,
  "std::readBinary": approve,
  "std::ls": approve,
  "std::glob": approve,
  "std::grep": approve,
  "std::wikipedia::search": approve,
  "std::wikipedia::summary": approve,
  "std::wikipedia::article": approve,
  "std::weather": approve,
  "std::search": approve,
  "std::tavilySearch": approve,
  "std::skills::skillsDir": approve,
  "std::skills::commandsDir": approve,
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
// std::policy's buildScopedMatch uses for "approve-always-here".
function dirScope(baseDir: string): string {
  return `{${baseDir},${baseDir}/**}`;
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
      "Auto-approve reads and web/search; prompt for writes, shell, and git changes.",
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
