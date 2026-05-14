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
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  } catch (e) {
    throw new Error(
      `'agency schedule add --backend github' must be run inside a git repo. (${(e as Error).message})`,
    );
  }
}

/**
 * Resolves symlinks in `p` so it can be compared meaningfully against
 * `git rev-parse --show-toplevel`, which always returns a real (resolved) path.
 * On macOS, `/tmp/foo` and `/var/folders/...` are symlinks to `/private/...`,
 * which would otherwise make `path.relative()` return `../...` for paths
 * that are conceptually inside the repo.
 *
 * Falls back to `path.resolve(p)` if the path doesn't exist on disk; the
 * caller (`install`) then runs the inside-repo check on the unresolved form,
 * which is acceptable because `scheduleAdd` validates the file exists before
 * dispatching to the backend.
 */
function realPathOrResolve(p: string): string {
  // Walk up the path until we find an ancestor that exists, realpath that,
  // then re-append the trailing components. This handles macOS symlinks like
  // /var/folders → /private/var/folders even when the leaf doesn't exist yet.
  const abs = path.resolve(p);
  let current = abs;
  const trailing: string[] = [];
  while (current !== path.dirname(current)) {
    try {
      const real = fs.realpathSync(current);
      return trailing.length === 0 ? real : path.join(real, ...trailing.reverse());
    } catch {
      trailing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
  return abs;
}

// GitHub Actions secret names: alphanumerics + underscore, must not start
// with a digit, must not start with `GITHUB_`. We're more permissive about
// the prefix rule here (we just need to avoid YAML-injection) and let
// GitHub itself reject the secret name on push if it's reserved.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new Error(
      `Invalid secret name "${name}". Secret names must match /^[A-Za-z_][A-Za-z0-9_]*$/ (letters, digits, underscore; no leading digit).`,
    );
  }
}

/** Quote a string as a YAML single-quoted scalar (escapes `'` by doubling). */
function yamlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Normalize a relative path to POSIX separators (workflows always run on Linux). */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
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
  // for pinned actions.
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
    // Validate secret names early so we fail before writing any file.
    for (const s of opts.secrets) validateSecretName(s);

    const root = repoRoot();
    // `git rev-parse --show-toplevel` returns a real (symlink-resolved) path,
    // so we resolve the agent file the same way for a meaningful comparison.
    // The file's parent directory must exist (scheduleAdd validates the file
    // itself exists upstream); we resolve the parent and re-attach the basename.
    const agentDir = realPathOrResolve(path.dirname(entry.agentFile));
    const resolvedAgentFile = path.join(agentDir, path.basename(entry.agentFile));
    const agentRel = path.relative(root, resolvedAgentFile);

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
      // Normalize to POSIX separators because the workflow runs on ubuntu,
      // and quote as YAML to handle paths containing special characters.
      agentFile: yamlQuote(toPosix(agentRel)),
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
