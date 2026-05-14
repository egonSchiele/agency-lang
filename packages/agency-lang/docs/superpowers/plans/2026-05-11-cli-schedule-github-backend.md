# CLI: `schedule add --backend github` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--backend github` mode to `agency schedule add` that emits a hardened `.github/workflows/<name>.yml` using SHA-pinned actions, instead of installing a local cron entry.

**Architecture:** A new `GithubBackend` implementing `ScheduleBackend.install`. The github backend is fire-and-forget: it writes the workflow file but skips the registry. A separate `InstallableBackendType` superset preserves the existing `BackendType` (registry) invariant. SHA pins live in a hand-maintained `pinnedActions.ts` updated at agency-lang release time using `gh api` (no Octokit dependency added to this package). Workflow YAML is rendered via a typestache template.

**Tech Stack:** TypeScript, typestache (existing), vitest. **Deliberately no Octokit dependency** — that would force every agency-lang user to install Octokit transitively. Refreshing pins is a release-engineering task, not a runtime task; we use `gh api` from a Makefile target.

### `--force` semantics

`--force` means different things per backend:
- **launchd / systemd / crontab:** overwrite the registry entry of the same name (and replace the on-disk service/cron file).
- **github:** overwrite an existing `.github/workflows/<name>.yml`. The github backend never touches the registry, so there's no registry collision to resolve.

A user running `agency schedule add x.agency --backend github --force` is opting into clobbering the workflow file in their working tree — a destructive but local operation that they can `git diff` before committing.

---

## File Structure

```
lib/cli/schedule/
  index.ts                              # MODIFY: extend AddOptions, branch on backend === "github"
  registry.ts                           # MODIFY: extend ScheduleEntry with optional `github` field
  backends/
    index.ts                            # MODIFY: add InstallableBackendType, getBackend("github") case
    github.ts                           # CREATE: GithubBackend class
    pinnedActions.ts                    # CREATE: hand-maintained map of action → { sha, tag }
    github.test.ts                      # CREATE: unit tests
lib/templates/cli/schedule/
  githubWorkflow.mustache               # CREATE: typestache template
  githubWorkflow.ts                     # GENERATED: by `pnpm run templates`
makefile                                # MODIFY: add a `refresh-action-pins` target using `gh api`
```

---

## Task 1: Type split for `BackendType` vs `InstallableBackendType`

**Files:**
- Modify: `lib/cli/schedule/backends/index.ts`
- Create: `lib/cli/schedule/backends/index.test.ts` (compile-time type test)

The `BackendType` in `registry.ts` stays exactly `"launchd" | "systemd" | "crontab"` — these are the registry-stored types. We add an `InstallableBackendType` superset for things that can be installed but may not be persisted.

> **Ordering note:** Tasks 1 and 6 must land together — the throwing-stub `case "github"` in Task 1 alone would let `--backend github` reach a `throw` at runtime if anyone bisected `main` between them. Either combine them into a single PR/commit or keep `main` consistent by landing Task 6's GithubBackend in the same change.

- [ ] **Step 1: Write failing type test**

```ts
// lib/cli/schedule/backends/index.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type { BackendType } from "../registry.js";
import type { InstallableBackendType } from "./index.js";

describe("backend type split", () => {
  it("BackendType is the registry-stored set", () => {
    expectTypeOf<BackendType>().toEqualTypeOf<"launchd" | "systemd" | "crontab">();
  });
  it("InstallableBackendType includes 'github'", () => {
    expectTypeOf<InstallableBackendType>()
      .toEqualTypeOf<"launchd" | "systemd" | "crontab" | "github">();
  });
});
```

- [ ] **Step 2: Run — fail**

```bash
pnpm test:run lib/cli/schedule/backends/index.test.ts
```

Expected: type error / "InstallableBackendType not exported".

- [ ] **Step 3: Modify `lib/cli/schedule/backends/index.ts`**

```ts
import { execFileSync } from "child_process";
import type { ScheduleEntry, BackendType } from "../registry.js";
import { LaunchdBackend } from "./launchd.js";
import { SystemdBackend } from "./systemd.js";
import { CrontabBackend } from "./crontab.js";

export type { BackendType } from "../registry.js";
export type InstallableBackendType = BackendType | "github";

export type ScheduleBackend = {
  install(entry: ScheduleEntry): void;
  uninstall(name: string): void;
};

export function detectBackend(): BackendType {
  if (process.platform === "darwin") return "launchd";
  try {
    execFileSync("which", ["systemctl"], { stdio: "pipe" });
    return "systemd";
  } catch {
    return "crontab";
  }
}

export function getBackend(type: InstallableBackendType): ScheduleBackend {
  switch (type) {
    case "launchd": return new LaunchdBackend();
    case "systemd": return new SystemdBackend();
    case "crontab": return new CrontabBackend();
    case "github":
      throw new Error("GithubBackend not yet implemented");
  }
}

export { LaunchdBackend } from "./launchd.js";
export { SystemdBackend } from "./systemd.js";
export { CrontabBackend } from "./crontab.js";
```

- [ ] **Step 4: Run — pass**

```bash
pnpm test:run lib/cli/schedule/backends/index.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add lib/cli/schedule/backends/index.ts lib/cli/schedule/backends/index.test.ts
git commit -m "refactor(schedule): introduce InstallableBackendType for non-registry backends"
```

---

## Task 2: `pinnedActions.ts` (hand-maintained)

**Files:**
- Create: `lib/cli/schedule/backends/pinnedActions.ts`

This file is hand-edited at agency-lang release time. There is no script to refresh it (intentionally — see Task 3 for why). When the engineer wants to bump action versions, they look up the SHA via `gh api` (per Task 3's documentation) and edit this file by hand. The diff is reviewable like any other code change.

The real SHA for `egonSchiele/run-agency-action@v1.0.0` won't exist until that repo is released. Ship a clearly-fake placeholder for now; replace it during the release that ships the github backend (see Task 15).

- [ ] **Step 1: Create the file**

```ts
// lib/cli/schedule/backends/pinnedActions.ts
//
// Hand-maintained. To bump versions:
//   1. Run `make refresh-action-pins` (which prints up-to-date SHAs).
//   2. Paste the new SHAs and tags here.
//   3. Commit. The diff should be small and reviewable.

export type PinnedAction = { sha: string; tag: string };

export const PINNED_ACTIONS: Record<string, PinnedAction> = {
  "actions/checkout": {
    sha: "b4ffde65f46336ab88eb53be808477a3936bae11",
    tag: "v4.1.7",
  },
  "egonSchiele/run-agency-action": {
    sha: "0000000000000000000000000000000000000000",
    tag: "v1.0.0",
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add lib/cli/schedule/backends/pinnedActions.ts
git commit -m "chore(schedule): add hand-maintained pinnedActions"
```

---

## Task 3: `make refresh-action-pins` target (no Octokit dep)

**Files:**
- Modify: `makefile`

We deliberately avoid an Octokit-based refresh script because that would force every agency-lang user to install Octokit transitively. Refreshing pins is a release-engineering task that the maintainer does once per bump using the `gh` CLI, which is already installed on every developer / CI machine that touches GitHub.

- [ ] **Step 1: Add a Makefile target**

Append to `makefile`:

```makefile
# Print the current SHAs for the actions used by `agency schedule add --backend github`.
# Manually paste into lib/cli/schedule/backends/pinnedActions.ts.
.PHONY: refresh-action-pins
refresh-action-pins:
	@echo "Look up these SHAs and update lib/cli/schedule/backends/pinnedActions.ts by hand:"
	@for spec in actions/checkout@v4 egonSchiele/run-agency-action@v1; do \
	  repo=$${spec%@*}; tag=$${spec#*@}; \
	  ref_obj=$$(gh api repos/$$repo/git/ref/tags/$$tag --jq '.object'); \
	  type=$$(echo "$$ref_obj" | jq -r '.type'); \
	  sha=$$(echo "$$ref_obj" | jq -r '.sha'); \
	  if [ "$$type" = "tag" ]; then \
	    sha=$$(gh api repos/$$repo/git/tags/$$sha --jq '.object.sha'); \
	  fi; \
	  printf "  %-40s %s  # %s\n" "$$repo" "$$sha" "$$tag"; \
	done
```

- [ ] **Step 2: Verify it runs**

```bash
make refresh-action-pins
```

Expected output (SHAs will vary):

```
Look up these SHAs and update lib/cli/schedule/backends/pinnedActions.ts by hand:
  actions/checkout                         b4ffde65f46336ab88eb53be808477a3936bae11  # v4
  egonSchiele/run-agency-action             <real-sha-once-released>                  # v1
```

- [ ] **Step 3: Commit**

```bash
git add makefile
git commit -m "chore(schedule): add 'make refresh-action-pins' Makefile target"
```

---

## Task 4: `githubWorkflow.mustache` template

**Files:**
- Create: `lib/templates/cli/schedule/githubWorkflow.mustache`
- After running typestache, file is generated at: `lib/templates/cli/schedule/githubWorkflow.ts`

- [ ] **Step 1: Create template**

**Important:** typestache uses fixed `{{`/`}}` delimiters with no escape syntax (verified in `node_modules/typestache/dist/lib/mustacheParser.js`). GitHub Actions `${{ secrets.X }}` syntax would be tokenized as a typestache variable tag (`{{ secrets.X }}` matches the tag-name regex), which would either type-error or substitute incorrectly. Therefore we **must** pre-render every line containing `${{ ... }}` in TypeScript and inject as a `{{{block:string}}}` triple-mustache. This mirrors the existing `lib/templates/cli/schedule/plist.mustache` pattern (which injects `{{{intervals:string}}}`).

The blocks pre-rendered in TS:
- `concurrencyGroup` — the line containing `${{ github.workflow }}`
- `permissionsBlock` — `contents: read` or `contents: write\n  pull-requests: write` (TS computes the indentation)
- `envBlock` — the entire `env:` block including `${{ secrets.X }}` lines

The blocks rendered via typestache (no GH Actions interpolation):
- `name`, `cron`, `agentFile`, `checkoutRef`, `runAgentActionRef`

```mustache
# Generated by `agency schedule add`. Edit freely.
# Action SHAs are pinned. Re-run `agency schedule add --force` after upgrading agency-lang to refresh.
name: {{name:string}}
on:
  schedule:
    - cron: '{{cron:string}}'
  workflow_dispatch:
permissions:
{{{permissionsBlock:string}}}
concurrency:
{{{concurrencyGroup:string}}}
  cancel-in-progress: false
jobs:
  run:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@{{checkoutRef:string}}
      - uses: egonSchiele/run-agency-action@{{runAgentActionRef:string}}
        with:
          file: {{agentFile:string}}
{{{envBlock:string}}}
```

The generated `githubWorkflow.ts` will export a default function whose argument type is:

```ts
type Args = {
  name: string;
  cron: string;
  agentFile: string;
  checkoutRef: string;
  runAgentActionRef: string;
  permissionsBlock: string;
  concurrencyGroup: string;
  envBlock: string;
};
```

The pre-rendered blocks (in `lib/cli/schedule/backends/github.ts`):

```ts
function renderPermissionsBlock(write: boolean): string {
  // Indented 2 spaces to sit under `permissions:`
  return write
    ? "  contents: write\n  pull-requests: write"
    : "  contents: read";
}

function renderConcurrencyGroup(): string {
  return "  group: agency-${{ github.workflow }}";
}

function renderEnvBlock(secrets: string[]): string {
  // Indented 8 spaces to sit under `        env:`
  const indent = "          ";
  const lines = [
    "        env:",
    `${indent}OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}`,
    `${indent}GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
    ...secrets.map((s) => `${indent}${s}: \${{ secrets.${s} }}`),
  ];
  return lines.join("\n");
}
```

Note the `\${{` — TypeScript template literals require escaping `${` to keep it literal.

- [ ] **Step 2: Generate the .ts**

```bash
pnpm run templates
```

Expected: `lib/templates/cli/schedule/githubWorkflow.ts` is created.

- [ ] **Step 3: Inspect generated TS**

Read the generated `.ts` to confirm the function signature. The template variables (`name`, `cron`, `permissions`, `checkoutRef`, `runAgentActionRef`, `agentFile`, `secrets`) should appear in the params type.

- [ ] **Step 4: Commit**

```bash
git add lib/templates/cli/schedule/githubWorkflow.mustache lib/templates/cli/schedule/githubWorkflow.ts
git commit -m "feat(schedule): add github workflow template"
```

---

## Task 5: Extend `ScheduleEntry` with optional `github` field

This must come before the `GithubBackend` task because the backend reads `entry.github`. Putting it first means the backend code can do `entry.github` directly without a type cast.

**Files:**
- Modify: `lib/cli/schedule/registry.ts`

- [ ] **Step 1: Add the optional field**

```ts
export type ScheduleEntry = {
  name: string;
  agentFile: string;
  cron: string;
  preset: string;
  envFile: string;
  logDir: string;
  createdAt: string;
  backend: BackendType;
  /** Github-only options. Never persisted to the registry. */
  github?: {
    secrets: string[];
    write: boolean;
    noPin: boolean;
    force: boolean;
  };
};
```

- [ ] **Step 2: Run all existing schedule tests**

```bash
pnpm test:run lib/cli/schedule
```

Expected: all green; existing tests unaffected (the new field is optional and not stored).

- [ ] **Step 3: Commit**

```bash
git add lib/cli/schedule/registry.ts
git commit -m "feat(schedule): add optional github field to ScheduleEntry"
```

---

## Task 6: `GithubBackend` class

**Files:**
- Create: `lib/cli/schedule/backends/github.ts`
- Create: `lib/cli/schedule/backends/github.test.ts`

- [ ] **Step 1: Write failing tests**

Note: this test file imports `ScheduleEntry`, which after Task 5 includes the optional `github` field — so no `as any` is needed in the helper.

```ts
// lib/cli/schedule/backends/github.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { GithubBackend } from "./github.js";
import type { ScheduleEntry } from "../registry.js";

type GithubOpts = NonNullable<ScheduleEntry["github"]>;

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function entry(opts: { name?: string; agentFile: string; cron?: string; preset?: string; github?: GithubOpts }): ScheduleEntry {
  return {
    name: opts.name ?? "test-sched",
    agentFile: opts.agentFile,
    cron: opts.cron ?? "0 * * * *",
    preset: opts.preset ?? "1h",
    envFile: "",
    logDir: "",
    createdAt: new Date().toISOString(),
    backend: "launchd", // ignored by GithubBackend
    github: opts.github ?? { secrets: [], write: false, noPin: false, force: false },
  };
}

describe("GithubBackend.install", () => {
  let repo: string;
  let cwd: string;
  beforeEach(() => { repo = setupRepo(); cwd = process.cwd(); process.chdir(repo); });
  afterEach(() => { process.chdir(cwd); fs.rmSync(repo, { recursive: true, force: true }); });

  it("writes .github/workflows/<name>.yml at repo root", () => {
    const e = entry({ agentFile: path.join(repo, "agents/foo.agency") });
    new GithubBackend().install(e);
    const target = path.join(repo, ".github/workflows/test-sched.yml");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("emits SHA pin by default", () => {
    const e = entry({ agentFile: path.join(repo, "agents/foo.agency") });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/test-sched.yml"), "utf-8");
    expect(yml).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(yml).toMatch(/egonSchiele\/run-agency-action@[0-9a-f]{40}/);
  });

  it("emits @<tag> when noPin: true", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: false, noPin: true, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/test-sched.yml"), "utf-8");
    expect(yml).toMatch(/egonSchiele\/run-agency-action@v\d/);
    expect(yml).not.toMatch(/egonSchiele\/run-agency-action@[0-9a-f]{40}/);
  });

  it("uses contents: read by default", () => {
    const e = entry({ agentFile: path.join(repo, "agents/foo.agency") });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/test-sched.yml"), "utf-8");
    expect(yml).toContain("contents: read");
    expect(yml).not.toContain("contents: write");
  });

  it("uses contents: write + pull-requests: write when write: true", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: [], write: true, noPin: false, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/test-sched.yml"), "utf-8");
    expect(yml).toContain("contents: write");
    expect(yml).toContain("pull-requests: write");
  });

  it("wires extra secrets into env block", () => {
    const e = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: ["FOO", "BAR"], write: false, noPin: false, force: false },
    });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/test-sched.yml"), "utf-8");
    expect(yml).toContain("FOO: ${{ secrets.FOO }}");
    expect(yml).toContain("BAR: ${{ secrets.BAR }}");
    expect(yml).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(yml).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("computes agent path relative to repo root", () => {
    const e = entry({ agentFile: path.join(repo, "agents/foo.agency") });
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/test-sched.yml"), "utf-8");
    expect(yml).toContain("file: agents/foo.agency");
  });

  it("throws when not in a git repo", () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"));
    process.chdir(nonGit);
    try {
      const e = entry({ agentFile: path.join(nonGit, "x.agency") });
      expect(() => new GithubBackend().install(e)).toThrow(/git repo/i);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("throws when agentFile is outside the repo", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-outside-"));
    try {
      const e = entry({ agentFile: path.join(otherDir, "elsewhere.agency") });
      expect(() => new GithubBackend().install(e)).toThrow(/outside the repo/i);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("throws on existing file without --force", () => {
    const e = entry({ agentFile: path.join(repo, "agents/foo.agency") });
    new GithubBackend().install(e);
    expect(() => new GithubBackend().install(e)).toThrow(/already exists/i);
  });

  it("overwrites with force: true", () => {
    const e = entry({ agentFile: path.join(repo, "agents/foo.agency") });
    new GithubBackend().install(e);
    const e2 = entry({
      agentFile: path.join(repo, "agents/foo.agency"),
      github: { secrets: ["NEW"], write: false, noPin: false, force: true },
    });
    expect(() => new GithubBackend().install(e2)).not.toThrow();
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/test-sched.yml"), "utf-8");
    expect(yml).toContain("NEW: ${{ secrets.NEW }}");
  });

  it("throws when an action's pinned SHA is the placeholder all-zeros value", async () => {
    // Test placeholder detection via vi.doMock around a fresh import.
    // Skip if testing infra makes this hard; covered indirectly by the
    // release-time check in Task 14.
  });
});
```

> The all-zeros SHA placeholder shipped in `pinnedActions.ts` (Task 2) gets replaced at release time (Task 14). At runtime, `actionRef()` validates the SHA isn't all-zeros and throws a clear error if it is. The test above is a stub — write it only if your test infra makes mocking module-level constants cheap. The release-time grep in Task 14 step 4 is the primary safety net.

- [ ] **Step 2: Run — fail**

```bash
pnpm test:run lib/cli/schedule/backends/github.test.ts
```

- [ ] **Step 3: Implement**

```ts
// lib/cli/schedule/backends/github.ts
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import type { ScheduleEntry } from "../registry.js";
import type { ScheduleBackend } from "./index.js";
import { PINNED_ACTIONS } from "./pinnedActions.js";
import renderGithubWorkflow from "@/templates/cli/schedule/githubWorkflow.js";

const ZERO_SHA = "0000000000000000000000000000000000000000";

const DEFAULT_GITHUB_OPTS: NonNullable<ScheduleEntry["github"]> = {
  secrets: [],
  write: false,
  noPin: false,
  force: false,
};

function repoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "pipe"] })
      .toString().trim();
  } catch (e) {
    throw new Error(
      `'agency schedule add --backend github' must be run inside a git repo. (${(e as Error).message})`,
    );
  }
}

function actionRef(name: string, noPin: boolean): string {
  const pin = PINNED_ACTIONS[name];
  if (!pin) throw new Error(`No pinned SHA for action: ${name}`);
  if (!noPin && pin.sha === ZERO_SHA) {
    throw new Error(
      `Pinned SHA for ${name} is the placeholder all-zeros value. ` +
        `This release of agency-lang shipped before the action was published. ` +
        `Re-run with --no-pin to use the @${pin.tag} tag, or upgrade agency-lang.`,
    );
  }
  // Inline YAML comment after `@<sha>` is the standard GitHub-recommended idiom
  // for pinned actions (see https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions).
  return noPin ? pin.tag : `${pin.sha}  # ${pin.tag}`;
}

function renderPermissionsBlock(write: boolean): string {
  return write
    ? "  contents: write\n  pull-requests: write"
    : "  contents: read";
}

function renderConcurrencyGroup(): string {
  return "  group: agency-${{ github.workflow }}";
}

function renderEnvBlock(secrets: string[]): string {
  const indent = "          ";
  const lines = [
    "        env:",
    `${indent}OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}`,
    `${indent}GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
    ...secrets.map((s) => `${indent}${s}: \${{ secrets.${s} }}`),
  ];
  return lines.join("\n");
}

export class GithubBackend implements ScheduleBackend {
  install(entry: ScheduleEntry): void {
    const opts = entry.github ?? DEFAULT_GITHUB_OPTS;
    const root = repoRoot();
    const agentRel = path.relative(root, entry.agentFile);

    // Disallow agent files outside the repo. `path.relative` returns a path
    // starting with ".." in that case; an absolute path means a different drive.
    if (agentRel.startsWith("..") || path.isAbsolute(agentRel)) {
      throw new Error(
        `Agent file is outside the repo root and cannot be referenced from a workflow: ${entry.agentFile} (repo root: ${root})`,
      );
    }

    const target = path.join(root, ".github", "workflows", `${entry.name}.yml`);

    if (fs.existsSync(target) && !opts.force) {
      throw new Error(
        `Workflow file already exists: ${target}. Use --force to overwrite.`,
      );
    }

    const yaml = renderGithubWorkflow({
      name: entry.name,
      cron: entry.cron,
      agentFile: agentRel,
      checkoutRef: actionRef("actions/checkout", opts.noPin),
      runAgentActionRef: actionRef("egonSchiele/run-agency-action", opts.noPin),
      permissionsBlock: renderPermissionsBlock(opts.write),
      concurrencyGroup: renderConcurrencyGroup(),
      envBlock: renderEnvBlock(opts.secrets),
    });

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, yaml);

    console.log(`Wrote ${path.relative(process.cwd(), target)}`);
    console.log("");
    console.log("Next steps:");
    console.log(`  1. Set secrets in github.com → repo Settings → Secrets and variables → Actions:`);
    console.log("       OPENAI_API_KEY (required)");
    for (const s of opts.secrets) {
      console.log(`       ${s}`);
    }
    console.log(`  2. git add ${path.relative(process.cwd(), target)}`);
    console.log(`     git commit -m "Add agency schedule: ${entry.name}"`);
    console.log(`     git push`);
  }

  // `uninstall` is unreachable for the github backend: scheduleRemove looks up
  // entries by name in the registry, and github schedules are never registered.
  // The interface requires this method, so we throw rather than silently no-op.
  uninstall(_name: string): never {
    throw new Error(
      "github schedules are not registered with `agency schedule`. To remove a github schedule, delete the workflow file: git rm .github/workflows/<name>.yml",
    );
  }
}
```

- [ ] **Step 4: Update getBackend switch**

In `lib/cli/schedule/backends/index.ts`, replace the github case:

```ts
case "github":
  return new GithubBackend();
```

And add the import at the top:

```ts
import { GithubBackend } from "./github.js";
```

- [ ] **Step 5: Run — pass**

```bash
pnpm test:run lib/cli/schedule/backends/github.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add lib/cli/schedule/backends/github.ts lib/cli/schedule/backends/github.test.ts lib/cli/schedule/backends/index.ts
git commit -m "feat(schedule): add GithubBackend"
```

---

## Task 7: `scheduleAdd` branch on backend === "github"

**Files:**
- Modify: `lib/cli/schedule/index.ts`
- Create: `lib/cli/schedule/index.github.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// lib/cli/schedule/index.github.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { scheduleAdd } from "./index.js";
import { Registry } from "./registry.js";

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-cli-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, "agents"));
  fs.writeFileSync(path.join(dir, "agents/foo.agency"), "node main() { print(1) }\n");
  return dir;
}

describe("scheduleAdd --backend github", () => {
  let repo: string;
  let baseDir: string;
  let cwd: string;
  beforeEach(() => {
    repo = setupRepo();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-base-"));
    cwd = process.cwd();
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("writes the workflow file", () => {
    scheduleAdd({
      file: path.join(repo, "agents/foo.agency"),
      every: "1h",
      backend: "github",
      baseDir,
    });
    expect(fs.existsSync(path.join(repo, ".github/workflows/foo.yml"))).toBe(true);
  });

  it("does NOT write to the registry", () => {
    scheduleAdd({
      file: path.join(repo, "agents/foo.agency"),
      every: "1h",
      backend: "github",
      baseDir,
    });
    const reg = new Registry(baseDir);
    expect(Object.keys(reg.getAll())).toHaveLength(0);
  });

  it("warns (does not error) on --every < 5m", () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      scheduleAdd({
        file: path.join(repo, "agents/foo.agency"),
        every: "1m",
        backend: "github",
        baseDir,
      });
      expect(warns.join("\n")).toMatch(/5.?min/i);
    } finally { console.warn = origWarn; }
  });

  it("passes secrets/write/noPin through to backend", () => {
    scheduleAdd({
      file: path.join(repo, "agents/foo.agency"),
      every: "1h",
      backend: "github",
      baseDir,
      secrets: ["FOO"],
      write: true,
      noPin: true,
    });
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/foo.yml"), "utf-8");
    expect(yml).toContain("FOO: ${{ secrets.FOO }}");
    expect(yml).toContain("contents: write");
    expect(yml).toMatch(/agency-lang\/run-agency-action@v\d/);
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Modify `lib/cli/schedule/index.ts`**

Add to imports:

```ts
import { detectBackend, getBackend, type InstallableBackendType } from "./backends/index.js";
```

Add a small helper at module scope. The cron expression here is always 5-field (`m h dom mon dow`) because `resolveCron` produces a normalized form. The minutes field is the only one we need to inspect for the < 5min check; if it's `*/N` with `N < 5` we warn. Anything else is fine for GH Actions. (Cadences like `*/3 * * * *` are the only realistic way to schedule sub-5min in cron.)

```ts
function cronIntervalMinutes(cron: string): number {
  const minutesField = cron.split(/\s+/)[0] ?? "";
  const m = minutesField.match(/^\*\/(\d+)$/);
  if (m) return Number(m[1]);
  // Anything else (specific minute, list, range, *) is >= 1 minute interval
  // but for our purpose isn't a sub-5min step: return Infinity to skip the warning.
  return Number.POSITIVE_INFINITY;
}
```

Update `AddOptions`:

```ts
export type AddOptions = {
  file: string;
  every?: string;
  cron?: string;
  name?: string;
  envFile?: string;
  baseDir?: string;
  force?: boolean;
  backend?: InstallableBackendType;
  secrets?: string[];
  write?: boolean;
  noPin?: boolean;
};
```

Modify `scheduleAdd`:

```ts
export function scheduleAdd(opts: AddOptions): void {
  const baseDir = opts.baseDir ?? defaultBaseDir();

  const agentFile = path.resolve(opts.file);
  if (!fs.existsSync(agentFile)) {
    throw new Error(`Agent file does not exist: ${agentFile}`);
  }
  if (opts.envFile && !fs.existsSync(opts.envFile)) {
    throw new Error(`Env file does not exist: ${opts.envFile}`);
  }

  const { cron, preset } = resolveCron({ every: opts.every, cron: opts.cron });
  const name = opts.name ?? path.basename(agentFile, ".agency");
  validateName(name);

  if (opts.backend === "github") {
    // GitHub Actions cron has 5-minute granularity; warn on tighter cadence.
    // We compute interval from the resolved cron expression rather than
    // pattern-matching on `preset`, which would be brittle (won't catch "30s",
    // "1minute", explicit `--cron`, etc.).
    if (cronIntervalMinutes(cron) < 5) {
      console.warn(
        `Warning: GitHub Actions cron has a 5-minute minimum granularity. ` +
          `The cadence "${preset || cron}" will be coarsened to ~5min by GitHub's scheduler.`,
      );
    }

    const entry: ScheduleEntry = {
      name,
      agentFile,
      cron,
      preset,
      envFile: opts.envFile ? path.resolve(opts.envFile) : "",
      logDir: "",
      createdAt: new Date().toISOString(),
      backend: "launchd", // unused; github backend is not registry-stored
      github: {
        secrets: opts.secrets ?? [],
        write: !!opts.write,
        noPin: !!opts.noPin,
        force: !!opts.force,
      },
    };

    getBackend("github").install(entry);
    // Intentionally skip registry.set for github backend.
    return;
  }

  // --- non-github (existing behavior) ---
  const registry = new Registry(baseDir);
  if (registry.has(name) && !opts.force) {
    throw new ScheduleExistsError(name);
  }
  const backendType = detectBackend();
  const backend = getBackend(backendType);
  const entry: ScheduleEntry = {
    name,
    agentFile,
    cron,
    preset,
    envFile: opts.envFile ? path.resolve(opts.envFile) : "",
    logDir: path.join(baseDir, name, "logs"),
    createdAt: new Date().toISOString(),
    backend: backendType,
  };
  backend.install(entry);
  registry.set(entry);
}
```

- [ ] **Step 4: Run — pass**

```bash
pnpm test:run lib/cli/schedule
```

- [ ] **Step 5: Commit**

```bash
git add lib/cli/schedule/index.ts lib/cli/schedule/index.github.test.ts
git commit -m "feat(schedule): branch scheduleAdd on backend === 'github'"
```

---

## Task 8: CLI flag wiring

**Files:**
- Modify: `scripts/agency.ts` (or wherever `schedule add` flags are parsed — confirm by `rg "schedule add" scripts lib/cli`)

- [ ] **Step 1: Locate the parse site**

```bash
rg -n "scheduleAdd|schedule add" scripts lib/cli
```

Expected: identify the file (likely `scripts/agency.ts`).

- [ ] **Step 2: Add flag parsing**

For `commander` style (adapt to the parser actually used):

```ts
schedule
  .command("add <file>")
  .description("Schedule an agent")
  .option("--every <duration>", "Run every duration (e.g. 1h, 30m)")
  .option("--cron <expr>", "Cron expression")
  .option("--name <name>", "Schedule name")
  .option("--env-file <path>", "Env file to load")
  .option("--force", "Overwrite an existing schedule")
  .option("--backend <type>", "Backend (launchd|systemd|crontab|github)")
  .option("--secret <name>", "Add a GitHub Actions secret to the workflow env (repeatable)", (v: string, prev: string[] = []) => [...prev, v], [])
  .option("--write", "github backend: grant contents: write + pull-requests: write")
  .option("--no-pin", "github backend: emit @<tag> instead of @<sha>")
  .action((file, optsCli) => {
    scheduleAdd({
      file,
      every: optsCli.every,
      cron: optsCli.cron,
      name: optsCli.name,
      envFile: optsCli.envFile,
      force: optsCli.force,
      backend: optsCli.backend,
      secrets: optsCli.secret,
      write: optsCli.write,
      // commander exposes `--no-pin` as `optsCli.pin === false` (defaults true).
      // We invert to a positive `noPin` for the API.
      noPin: optsCli.pin === false,
    });
  });
```

> Verify by running `pnpm run agency schedule add --help` after changes; commander's `--no-X` flag inversion is consistent across versions but the parser library actually used in `scripts/agency.ts` may differ. Confirm by inspecting what `optsCli` looks like.

- [ ] **Step 3: Smoke test from the CLI**

```bash
cd /tmp && mkdir gh-smoke && cd gh-smoke && git init
echo "node main() { print(1) }" > foo.agency
pnpm --filter agency-lang exec agency schedule add /tmp/gh-smoke/foo.agency --backend github --every 1h --secret FOO --write
cat .github/workflows/foo.yml
```

Expected: file exists, has FOO secret + write permissions. Clean up afterward: `rm -rf /tmp/gh-smoke`.

- [ ] **Step 4: Commit**

```bash
git add scripts/agency.ts
git commit -m "feat(schedule): wire --backend github CLI flags"
```

---

## Task 9: Snapshot tests for rendered YAML

**Files:**
- Create: `lib/cli/schedule/backends/github.snapshot.test.ts`

- [ ] **Step 1: Write snapshot tests**

```ts
// lib/cli/schedule/backends/github.snapshot.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { GithubBackend } from "./github.js";
import type { ScheduleEntry } from "../registry.js";

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-gh-snap-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function entry(github: any): ScheduleEntry {
  return {
    name: "snap", agentFile: "/tmp-WILL-REWRITE/agents/foo.agency",
    cron: "0 * * * *", preset: "1h", envFile: "", logDir: "",
    createdAt: "1970-01-01T00:00:00.000Z", backend: "launchd",
    github,
  } as ScheduleEntry;
}

describe.each([
  ["default-readonly",   { secrets: [],            write: false, noPin: false, force: false }],
  ["write",              { secrets: [],            write: true,  noPin: false, force: false }],
  ["with-secrets",       { secrets: ["FOO","BAR"], write: false, noPin: false, force: false }],
  ["no-pin",             { secrets: [],            write: false, noPin: true,  force: false }],
  ["all",                { secrets: ["FOO"],       write: true,  noPin: true,  force: false }],
])("snapshot: %s", (label, github) => {
  let repo: string; let cwd: string;
  beforeEach(() => { repo = setupRepo(); cwd = process.cwd(); process.chdir(repo); });
  afterEach(() => { process.chdir(cwd); fs.rmSync(repo, { recursive: true, force: true }); });

  it("matches snapshot", () => {
    const e = entry(github);
    e.agentFile = path.join(repo, "agents/foo.agency");
    new GithubBackend().install(e);
    const yml = fs.readFileSync(path.join(repo, ".github/workflows/snap.yml"), "utf-8");
    expect(yml).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run — generates snapshots**

```bash
pnpm test:run lib/cli/schedule/backends/github.snapshot.test.ts
```

Expected: snapshots written to `__snapshots__/`. Inspect them to confirm output matches the spec's example YAML (lines 63-88).

- [ ] **Step 3: Commit**

```bash
git add lib/cli/schedule/backends/github.snapshot.test.ts lib/cli/schedule/backends/__snapshots__/
git commit -m "test(schedule): snapshot tests for github workflow YAML"
```

---

## Task 10: Verify scheduleList / scheduleRemove are unaffected

**Files:**
- Modify: `lib/cli/schedule/index.test.ts` (add cases)

- [ ] **Step 1: Add tests**

```ts
// in existing lib/cli/schedule/index.test.ts (or create a new file if cleaner)
import { scheduleAdd, scheduleList } from "./index.js";
// ... existing imports ...

describe("github schedules are excluded from list/remove", () => {
  // Use the same temp-repo + temp-baseDir helpers from Task 7's tests.
  it("github add does not appear in scheduleList", () => {
    // setup repo + agent + baseDir, then:
    scheduleAdd({
      file: agentFile, every: "1h", backend: "github", baseDir,
    });
    const entries = scheduleList({ baseDir });
    expect(entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — pass**

```bash
pnpm test:run lib/cli/schedule/index.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add lib/cli/schedule/index.test.ts
git commit -m "test(schedule): confirm github schedules are not registry-listed"
```

---

## Task 11: README / docs update

**Files:**
- Modify: `README.md` (root) — locate the schedule section
- Modify: `docs/site/guide/<scheduling-doc>.md` if one exists (`rg -l 'schedule add' docs/`)

- [ ] **Step 1: Find scheduling docs**

```bash
rg -l "schedule add" README.md docs/
```

- [ ] **Step 2: Add a github-backend section**

Append to the relevant doc:

````markdown
### Run on GitHub Actions

To run an agent on GitHub Actions instead of locally:

```bash
agency schedule add agents/foo.agency \
  --backend github \
  --every 1h \
  --secret SLACK_WEBHOOK \
  --write
```

This generates `.github/workflows/foo.yml` in your repo. Commit and push it; the agent will run on GitHub's runners on the chosen cadence.

- `--secret NAME` (repeatable) wires a secret into the workflow's `env:` block.
- `--write` grants `contents: write` + `pull-requests: write` (e.g. for agents that open PRs).
- `--no-pin` emits `@<tag>` instead of `@<sha>` action references (less secure; default is SHA pins).
- `--force` overwrites an existing workflow file.

The agent file MUST live inside the git repo (it is referenced by relative path from the workflow). Cadences faster than 5 minutes will be coarsened by GitHub's scheduler — agency-lang prints a warning when this happens.

To remove a github schedule, `git rm` the workflow file. github schedules are not tracked by `agency schedule list` / `remove` — the workflow file in your repo is the source of truth.
````

- [ ] **Step 3: Commit**

```bash
git add README.md docs/
git commit -m "docs(schedule): document github backend"
```

---

## Task 12: Full test pass + stdlib rebuild

- [ ] **Step 1: Rebuild per AGENTS.md**

```bash
make 2>&1 | tee /tmp/agency-build.log
```

Expected: clean build.

- [ ] **Step 2: Run all tests**

```bash
pnpm test:run 2>&1 | tee /tmp/agency-tests.log
```

Expected: all green. If any pre-existing flaky tests fail, document and proceed only after consulting the user.

- [ ] **Step 3: Lint**

```bash
pnpm run lint:structure 2>&1 | tee /tmp/agency-lint.log
```

- [ ] **Step 4: Commit anything that came out of build/lint**

```bash
git add -u
git diff --cached --quiet || git commit -m "chore: rebuild after schedule github backend"
```

---

## Task 13: Manual smoke test

- [ ] **Step 1: Create a throwaway repo and try the full flow**

```bash
TMP=$(mktemp -d) && cd "$TMP"
git init
mkdir agents
cat > agents/hello.agency <<'AGENCY'
node main() {
  print("hello from CI")
}
AGENCY
pnpm --filter agency-lang exec agency schedule add agents/hello.agency \
  --backend github --every 1h --secret SLACK_WEBHOOK
cat .github/workflows/hello.yml
```

Expected output:
- "Wrote .github/workflows/hello.yml"
- Next-steps message listing OPENAI_API_KEY and SLACK_WEBHOOK
- The YAML matches the spec's example (lines 63-88) with `contents: read`, SHA pins, the secret wired into `env:`.

- [ ] **Step 2: Try --write and --no-pin**

```bash
rm .github/workflows/hello.yml
pnpm --filter agency-lang exec agency schedule add agents/hello.agency \
  --backend github --every 1h --write --no-pin
cat .github/workflows/hello.yml
```

Expected: `contents: write`, `pull-requests: write`, `egonSchiele/run-agency-action@v1` (no SHA).

- [ ] **Step 3: Try without `--force` on existing file**

```bash
pnpm --filter agency-lang exec agency schedule add agents/hello.agency \
  --backend github --every 1h
```

Expected: error containing "already exists. Use --force to overwrite."

- [ ] **Step 4: Try outside a git repo**

```bash
cd /tmp/$(uuidgen)-non-git
mkdir -p .
echo "node main() { print(1) }" > x.agency
pnpm --filter agency-lang exec agency schedule add x.agency --backend github --every 1h
```

Expected: error containing "must be run inside a git repo".

- [ ] **Step 5: Clean up**

```bash
rm -rf "$TMP"
```

---

## Task 14: Release coordination (manual SHA refresh)

This task is documentation-only — to be executed when the agency-lang release that ships the github backend is cut.

- [ ] **Step 1: Verify `egonSchiele/run-agency-action` v1.x is published**

Check that `https://github.com/egonSchiele/run-agency-action/releases/tag/v1.0.0` exists.

- [ ] **Step 2: Look up current SHAs**

```bash
make refresh-action-pins
```

Expected output: a printed list of SHA + tag pairs for each pinned action.

- [ ] **Step 3: Hand-edit `lib/cli/schedule/backends/pinnedActions.ts`**

Paste the SHAs and tags into the file. The `egonSchiele/run-agency-action` placeholder (`0000…`) is replaced with the real SHA.

- [ ] **Step 4: Verify**

```bash
grep "egonSchiele/run-agency-action" lib/cli/schedule/backends/pinnedActions.ts
```

Expected: a real 40-char SHA, not `0000…`.

- [ ] **Step 5: Bump agency-lang version + CHANGELOG**

(Standard release process for this repo.)

- [ ] **Step 6: Commit and tag**

```bash
git add lib/cli/schedule/backends/pinnedActions.ts CHANGELOG.md package.json
git commit -m "release: agency-lang vX.Y.Z with github schedule backend"
git tag vX.Y.Z
```

---

## Self-review

- **Spec coverage:**
  - CLI surface (spec §"Surface"): Tasks 7, 8.
  - Behavior steps 1-7 (spec §"Behavior"): Tasks 6, 7.
  - Generated YAML (spec lines 63-88): Tasks 4, 6, 9 (snapshot).
  - Hardening rationale (spec §"Hardening rationale"): SHA pins via Tasks 2, 3, 14; ubuntu-24.04, contents: read default, concurrency guard, no event interpolation — all baked into Task 4 template + the `renderEnvBlock`/`renderConcurrencyGroup`/`renderPermissionsBlock` helpers in Task 6.
  - Pinned action SHAs (spec §"Pinned action SHAs"): Task 2 (file), Task 3 (`make refresh-action-pins`), Task 14 (release-time refresh). All-zeros SHA placeholder is detected at runtime by `actionRef()` (Task 6).
  - Implementation files table (spec lines 121-128): all six files mapped — `github.ts` Task 6; `backends/index.ts` Tasks 1, 6; `index.ts` Task 7; `pinnedActions.ts` Task 2; `refresh-action-pins.ts` is **deliberately omitted** — replaced by Task 3's Makefile target to avoid adding an Octokit dependency to agency-lang; `githubWorkflow.mustache` Task 4.
  - Tests (spec §"Tests"): Tasks 6, 9, 10, 7. `--every < 5m` warning Task 7 (now uses `cronIntervalMinutes()` instead of brittle preset regex).
  - `scheduleList` / `scheduleRemove` unchanged: Task 10.
  - Github backend `uninstall` is unreachable dead code; throws if called: Task 6.

- **Mustache delimiter collision (Task 4):** typestache uses fixed `{{`/`}}` delimiters with no escape mechanism. GH Actions `${{ ... }}` syntax is unambiguously a typestache tag from the parser's perspective. The plan resolves this by pre-rendering every `${{ ... }}`-containing block in TS (`envBlock`, `concurrencyGroup`) and injecting via `{{{block:string}}}` triple-mustache (matching the existing `plist.mustache` idiom for `intervals`).

- **Type/name consistency:**
  - `InstallableBackendType` defined Task 1, used Task 7.
  - `ScheduleEntry.github` shape (`secrets, write, noPin, force`) consistent across `registry.ts` (Task 5), `GithubBackend` (Task 6), `AddOptions` (Task 7), CLI flags (Task 8), tests (Tasks 6, 7, 9).
  - `PINNED_ACTIONS` shape (`{ sha, tag }`) consistent between Task 2 and the `actionRef()` consumer in Task 6.
  - Template variable names (`name, cron, agentFile, checkoutRef, runAgentActionRef, permissionsBlock, concurrencyGroup, envBlock`) match between Task 4's mustache template and Task 6's `renderGithubWorkflow` call site.
  - Action repo name `egonSchiele/run-agency-action` is consistent across `pinnedActions.ts`, the template, and the test assertions.

- **Anti-patterns / coding standards** (per `docs/dev/`):
  - No `interface`, no `Map`, no dynamic imports.
  - No `as any` in tests — `entry()` helper uses a strict typed parameter shape.
  - `entry.github ?? DEFAULT_GITHUB_OPTS` pattern uses a top-level `const` rather than a helper function.
  - The `--force` flag's per-backend semantics are documented in the Architecture section.
  - No Octokit dependency added to agency-lang (per user request).
  - Agent files outside the repo root are rejected with a clear error.

Plan saved to docs/superpowers/plans/2026-05-11-cli-schedule-github-backend.md
