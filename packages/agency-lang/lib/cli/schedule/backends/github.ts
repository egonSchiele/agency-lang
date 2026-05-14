import * as fs from "fs";
import * as path from "path";
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

// GitHub Actions secret names: alphanumerics + underscore, must not start
// with a digit. We're more permissive about the leading-`GITHUB_` rule and
// let GitHub itself reject reserved prefixes on push -- we just need to
// avoid YAML-injection here.
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
  /**
   * Writes a `<name>.yml` workflow file to the current working directory.
   *
   * The github backend is intentionally git-agnostic: it does not assume the
   * user is inside their target repo, does not resolve any paths, and does
   * not validate that the agent file exists. The `file:` line in the rendered
   * workflow uses whatever path string the user passed verbatim. The user is
   * expected to:
   *   1. Move the file to `.github/workflows/<name>.yml` in their repo
   *   2. Verify the `file:` line points to the agent in the repo
   *   3. git add / commit / push
   */
  install(entry: ScheduleEntry): void {
    const opts = entry.github ?? DEFAULT_GITHUB_OPTS;
    // Validate secret names early so we fail before writing any file.
    for (const s of opts.secrets) validateSecretName(s);

    const target = path.resolve(`${entry.name}.yml`);

    if (fs.existsSync(target) && !opts.force) {
      throw new Error(
        `File already exists: ${target}. Use --force to overwrite.`,
      );
    }

    const yaml = renderGithubWorkflow({
      name: entry.name,
      cron: entry.cron,
      // YAML-quote to handle paths containing special characters such as
      // `#`, `: `, or single quotes.
      agentFile: yamlQuote(entry.agentFile),
      checkoutRef: actionRef("actions/checkout", opts.noPin),
      runAgentActionRef: actionRef("egonSchiele/run-agency-action", opts.noPin),
      permissionsBlock: renderPermissionsBlock(opts.write),
      concurrencyGroup: renderConcurrencyGroup(),
      envBlock: renderEnvBlock(opts.secrets),
    });

    fs.writeFileSync(target, yaml);

    console.log(`Wrote ${target}`);
    console.log("");
    console.log("Next steps:");
    console.log(
      `  1. Move this file into your repo at .github/workflows/${entry.name}.yml`,
    );
    console.log(
      `  2. Open the file and verify the 'file:' line points to your agent's path in the repo (currently set to ${entry.agentFile}).`,
    );
    console.log(
      "  3. Set secrets in github.com -> repo Settings -> Secrets and variables -> Actions:",
    );
    console.log("       OPENAI_API_KEY (required)");
    for (const s of opts.secrets) {
      console.log(`       ${s}`);
    }
    console.log("  4. git add, commit, and push.");
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
