import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Registry, type ScheduleEntry } from "./registry.js";
import { resolveCron, formatSchedule, nextRun } from "./cron.js";
import { detectBackend, getBackend } from "./backends/index.js";

export class ScheduleExistsError extends Error {
  constructor(public readonly scheduleName: string) {
    super(
      `A schedule named "${scheduleName}" already exists. Use --name to pick a different name, or remove the existing one first.`,
    );
  }
}

function defaultBaseDir(): string {
  return path.join(os.homedir(), ".agency", "schedules");
}

export type AddOptions = {
  file: string;
  every?: string;
  cron?: string;
  name?: string;
  envFile?: string;
  command?: string;
  baseDir?: string;
  force?: boolean;
};

export function scheduleAdd(opts: AddOptions): void {
  const baseDir = opts.baseDir ?? defaultBaseDir();
  const registry = new Registry(baseDir);

  const agentFile = path.resolve(opts.file);
  if (!fs.existsSync(agentFile)) {
    throw new Error(`Agent file does not exist: ${agentFile}`);
  }
  if (opts.envFile && !fs.existsSync(opts.envFile)) {
    throw new Error(`Env file does not exist: ${opts.envFile}`);
  }

  const { cron, preset } = resolveCron({ every: opts.every, cron: opts.cron });
  const name = opts.name ?? path.basename(agentFile, ".agency");

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
    command: opts.command ?? "agency",
    logDir: path.join(baseDir, name, "logs"),
    createdAt: new Date().toISOString(),
    backend: backendType,
  };

  const oldEntry = registry.get(name);
  if (oldEntry) backend.uninstall(name);
  registry.set(entry);

  try {
    backend.install(entry);
  } catch (err) {
    // Rollback: restore old entry or remove new one
    if (oldEntry) {
      registry.set(oldEntry);
      try { backend.install(oldEntry); } catch {}
    } else {
      registry.remove(name);
    }
    throw err;
  }
}

export type ListOptions = { baseDir?: string };

export type ListEntry = {
  name: string;
  agentFile: string;
  schedule: string;
  nextRun: Date;
  broken: boolean;
};

export function scheduleList(opts: ListOptions): ListEntry[] {
  const registry = new Registry(opts.baseDir ?? defaultBaseDir());
  return Object.values(registry.getAll()).map((entry) => ({
    name: entry.name,
    agentFile: entry.agentFile,
    schedule: formatSchedule(entry.cron, entry.preset),
    nextRun: nextRun(entry.cron),
    broken: !fs.existsSync(entry.agentFile),
  }));
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
  command?: string;
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
    command: opts.command ?? existing.command,
  };

  const backend = getBackend(existing.backend);
  backend.uninstall(opts.name);
  registry.set(updated);

  try {
    backend.install(updated);
  } catch (err) {
    // Rollback: restore old schedule
    registry.set(existing);
    try { backend.install(existing); } catch {}
    throw err;
  }
}
