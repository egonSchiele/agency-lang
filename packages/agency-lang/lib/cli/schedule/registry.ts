import * as fs from "fs";
import * as path from "path";

export type BackendType = "launchd" | "systemd" | "crontab";

export type ScheduleEntry = {
  name: string;
  agentFile: string;
  cron: string;
  preset: string;
  envFile: string;
  command: string;
  logDir: string;
  createdAt: string;
  backend: BackendType;
};

export type ScheduleRegistry = Record<string, ScheduleEntry>;

export class Registry {
  private filePath: string;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, "schedules.json");
  }

  getAll(): ScheduleRegistry {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      throw new Error(
        `Failed to parse schedule registry at ${this.filePath}. The file may be corrupted. Delete it to reset: rm "${this.filePath}"`,
      );
    }
  }

  get(name: string): ScheduleEntry | undefined {
    return this.getAll()[name];
  }

  has(name: string): boolean {
    return Object.hasOwn(this.getAll(), name);
  }

  set(entry: ScheduleEntry): void {
    const all = this.getAll();
    all[entry.name] = entry;
    this.write(all);
  }

  remove(name: string): void {
    const all = this.getAll();
    delete all[name];
    this.write(all);
  }

  private write(data: ScheduleRegistry): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}
