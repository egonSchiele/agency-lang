import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Registry, type ScheduleEntry } from "./registry.js";
import { resolveCron, formatSchedule } from "./cron.js";
import {
  detectBackend,
  getBackend,
  type InstallableBackendType,
} from "./backends/index.js";

function cronIntervalMinutes(cron: string): number {
  const minutesField = cron.split(/\s+/)[0] ?? "";
  const m = minutesField.match(/^\*\/(\d+)$/);
  if (m) return Number(m[1]);
  // Anything else (specific minute, list, range, *) isn't a sub-5min step.
  return Number.POSITIVE_INFINITY;
}

export async function promptScheduleOverwrite(name: string): Promise<boolean> {
  const prompts = (await import("prompts")).default;
  const { overwrite } = await prompts({
    type: "confirm",
    name: "overwrite",
    message: `A schedule named "${name}" already exists. Overwrite?`,
    initial: false,
  });
  return overwrite ?? false;
}

export class ScheduleExistsError extends Error {
  constructor(public readonly scheduleName: string) {
    super(
      `A schedule named "${scheduleName}" already exists. Use --name to pick a different name, or remove the existing one first.`,
    );
  }
}

const VALID_NAME = /^[A-Za-z0-9._-]+$/;

function defaultBaseDir(): string {
  return path.join(os.homedir(), ".agency", "schedules");
}

function validateName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid schedule name "${name}". Names may only contain letters, numbers, dots, hyphens, and underscores.`,
    );
  }
}

export type AddOptions = {
  file: string;
  every?: string;
  cron?: string;
  name?: string;
  envFile?: string;
  baseDir?: string;
  force?: boolean;
  backend?: InstallableBackendType;
  /** github backend: extra secrets to wire into the workflow's env block. */
  secrets?: string[];
  /** github backend: grant `contents: write` + `pull-requests: write`. */
  write?: boolean;
  /** github backend: emit `@<tag>` instead of `@<sha>` for action references. */
  noPin?: boolean;
};

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

  // Install first (overwrites existing config files in-place), then update registry.
  // If install fails, the old config files are still in place and the registry is unchanged.
  backend.install(entry);
  registry.set(entry);
}

export type ListOptions = { baseDir?: string };

export type ListEntry = {
  name: string;
  agentFile: string;
  schedule: string;
  broken: boolean;
};

export function scheduleList(opts: ListOptions): ListEntry[] {
  const registry = new Registry(opts.baseDir ?? defaultBaseDir());
  return Object.values(registry.getAll()).map((entry) => ({
    name: entry.name,
    agentFile: entry.agentFile,
    schedule: formatSchedule(entry.cron, entry.preset),
    broken: !fs.existsSync(entry.agentFile),
  }));
}

function displayPath(absolutePath: string): string {
  const rel = path.relative(process.cwd(), absolutePath);
  return rel.startsWith("..") ? absolutePath : rel;
}

export function formatListTable(entries: ListEntry[]): string {
  if (entries.length === 0) {
    return "No scheduled agents. Use 'agency schedule add' to create one.";
  }

  const display = entries.map((e) => ({ ...e, displayAgent: displayPath(e.agentFile) }));
  const nameW = Math.max(4, ...display.map((e) => e.name.length)) + 2;
  const agentW = Math.max(5, ...display.map((e) => e.displayAgent.length)) + 2;

  const lines: string[] = [];
  lines.push("Name".padEnd(nameW) + "Agent".padEnd(agentW) + "Schedule");
  for (const entry of display) {
    const broken = entry.broken ? " [broken]" : "";
    lines.push(
      entry.name.padEnd(nameW) +
        (entry.displayAgent + broken).padEnd(agentW) +
        entry.schedule,
    );
  }
  return lines.join("\n");
}

export type RemoveOptions = { name: string; baseDir?: string };

export function scheduleRemove(opts: RemoveOptions): void {
  const registry = new Registry(opts.baseDir ?? defaultBaseDir());
  const entry = registry.get(opts.name);
  if (!entry) {
    throw new Error(
      `No schedule named "${opts.name}". Run 'agency schedule list' to see available schedules.`,
    );
  }
  getBackend(entry.backend).uninstall(opts.name);
  registry.remove(opts.name);
}

export type EditOptions = {
  name: string;
  every?: string;
  cron?: string;
  envFile?: string;
  baseDir?: string;
};

export function scheduleEdit(opts: EditOptions): void {
  const registry = new Registry(opts.baseDir ?? defaultBaseDir());
  const existing = registry.get(opts.name);
  if (!existing) {
    throw new Error(
      `No schedule named "${opts.name}". Run 'agency schedule list' to see available schedules.`,
    );
  }

  if (opts.envFile && !fs.existsSync(opts.envFile)) {
    throw new Error(`Env file does not exist: ${opts.envFile}`);
  }

  const { cron, preset } =
    opts.every || opts.cron
      ? resolveCron({ every: opts.every, cron: opts.cron })
      : { cron: existing.cron, preset: existing.preset };

  const updated: ScheduleEntry = {
    ...existing,
    cron,
    preset,
    envFile: opts.envFile ? path.resolve(opts.envFile) : existing.envFile,
  };

  // Install first (overwrites existing config files in-place), then update registry.
  // If install fails, the old config files are still in place and the registry is unchanged.
  const backend = getBackend(existing.backend);
  backend.install(updated);
  registry.set(updated);
}
