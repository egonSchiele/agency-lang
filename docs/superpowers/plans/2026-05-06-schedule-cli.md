# Schedule CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agency schedule add/list/remove/edit` commands that register OS-native cron jobs (launchd, systemd, crontab) to run Agency agents on a recurring schedule.

**Architecture:** A JSON registry at `~/.agency/schedules/schedules.json` stores schedule metadata. Three backend implementations (launchd, systemd, crontab) handle OS-specific install/uninstall. The CLI commands in `lib/cli/schedule/index.ts` orchestrate validation, registry updates, and backend calls.

**Tech Stack:** Commander (CLI), Node.js `child_process` (for launchctl/systemctl/crontab), Node.js `fs` (registry and log management), typestache (typed Mustache templates for generated config files).

**Spec:** `docs/superpowers/specs/2026-05-06-schedule-cli-design.md`

## File Structure

```
lib/cli/schedule/
├── index.ts              — Public API: scheduleAdd, scheduleList, scheduleRemove, scheduleEdit
├── index.test.ts         — Tests for the public API
├── registry.ts           — Registry class (JSON persistence)
├── registry.test.ts      — Registry tests
├── cron.ts               — Cron utilities: validate, presets, nextRun, cronToOnCalendar
├── cron.test.ts          — Cron utility tests
├── backends/
│   ├── index.ts          — ScheduleBackend interface, detectBackend, getBackend factory
│   ├── launchd.ts        — LaunchdBackend
│   ├── systemd.ts        — SystemdBackend
│   ├── crontab.ts        — CrontabBackend
│   └── backends.test.ts  — Backend tests

lib/templates/cli/schedule/
├── plist.mustache        — launchd plist template
├── service.mustache      — systemd service unit template
├── timer.mustache        — systemd timer unit template
├── runScript.mustache    — Shared run.sh wrapper script template
```

**Template usage:** Templates are compiled to TypeScript via `pnpm run templates` (which runs `typestache ./lib/templates`). Each `.mustache` file produces a `.ts` file with a typed `render(args)` function. Backends import and call `render()` with their data — no string concatenation needed.

---

### Task 1: Registry and Types

**Files:**
- Create: `packages/agency-lang/lib/cli/schedule/registry.ts`
- Create: `packages/agency-lang/lib/cli/schedule/registry.test.ts`

This module manages reading/writing `~/.agency/schedules/schedules.json` and defines the core types.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Registry } from "../schedule/registry.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function makeEntry(tmpDir: string, overrides = {}) {
  return {
    name: "test-agent",
    agentFile: "/path/to/agent.agency",
    cron: "0 9 * * *",
    preset: "daily",
    envFile: "",
    command: "agency",
    logDir: path.join(tmpDir, "test-agent", "logs"),
    createdAt: "2026-05-06T10:00:00-07:00",
    backend: "launchd" as const,
    ...overrides,
  };
}

describe("Registry", () => {
  let tmpDir: string;
  let registry: Registry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-schedule-test-"));
    registry = new Registry(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when no registry file exists", () => {
    expect(registry.getAll()).toEqual({});
  });

  it("adds and retrieves an entry", () => {
    const entry = makeEntry(tmpDir);
    registry.set(entry);
    expect(registry.get("test-agent")).toEqual(entry);
  });

  it("removes an entry", () => {
    registry.set(makeEntry(tmpDir));
    registry.remove("test-agent");
    expect(registry.get("test-agent")).toBeUndefined();
  });

  it("persists across instances", () => {
    const entry = makeEntry(tmpDir);
    registry.set(entry);
    const registry2 = new Registry(tmpDir);
    expect(registry2.get("test-agent")).toEqual(entry);
  });

  it("has() returns true for existing entries", () => {
    registry.set(makeEntry(tmpDir));
    expect(registry.has("test-agent")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement Registry**

```typescript
// packages/agency-lang/lib/cli/schedule/registry.ts
import * as fs from "fs";
import * as path from "path";

export type ScheduleEntry = {
  name: string;
  agentFile: string;
  cron: string;
  preset: string;
  envFile: string;
  command: string;
  logDir: string;
  createdAt: string;
  backend: "launchd" | "systemd" | "crontab";
};

export type ScheduleRegistry = Record<string, ScheduleEntry>;

export class Registry {
  private filePath: string;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, "schedules.json");
  }

  getAll(): ScheduleRegistry {
    if (!fs.existsSync(this.filePath)) return {};
    return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
  }

  get(name: string): ScheduleEntry | undefined {
    return this.getAll()[name];
  }

  has(name: string): boolean {
    return name in this.getAll();
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
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/registry.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```
git add packages/agency-lang/lib/cli/schedule/registry.ts packages/agency-lang/lib/cli/schedule/registry.test.ts
git commit -m "feat(schedule): add schedule registry with types and persistence"
```

---

### Task 2: Cron Validation, Presets, and Utilities

**Files:**
- Create: `packages/agency-lang/lib/cli/schedule/cron.ts`
- Create: `packages/agency-lang/lib/cli/schedule/cron.test.ts`

This module handles all cron-related logic: presets, validation, next-run calculation, cron-to-systemd conversion, and resolving user input into a `{ cron, preset }` pair.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import {
  presetToCron,
  validateCron,
  formatSchedule,
  nextRun,
  resolveCron,
  cronToOnCalendar,
} from "../schedule/cron.js";

describe("presetToCron", () => {
  it("maps hourly", () => expect(presetToCron("hourly")).toBe("0 * * * *"));
  it("maps daily", () => expect(presetToCron("daily")).toBe("0 9 * * *"));
  it("maps weekdays", () => expect(presetToCron("weekdays")).toBe("0 9 * * 1-5"));
  it("maps weekly", () => expect(presetToCron("weekly")).toBe("0 9 * * 1"));
  it("throws on unknown preset", () => {
    expect(() => presetToCron("biweekly")).toThrow("Unknown preset");
  });
});

describe("validateCron", () => {
  it("accepts valid 5-field expressions", () => {
    expect(validateCron("0 9 * * *")).toBe(true);
    expect(validateCron("*/15 * * * *")).toBe(true);
    expect(validateCron("0 9 * * 1-5")).toBe(true);
    expect(validateCron("30 14 1 * *")).toBe(true);
  });
  it("rejects invalid expressions", () => {
    expect(validateCron("not a cron")).toBe(false);
    expect(validateCron("* * *")).toBe(false);
    expect(validateCron("")).toBe(false);
    expect(validateCron("* * * * * *")).toBe(false);
  });
});

describe("resolveCron", () => {
  it("resolves a preset", () => {
    expect(resolveCron({ every: "daily" })).toEqual({ cron: "0 9 * * *", preset: "daily" });
  });
  it("resolves a raw cron expression", () => {
    expect(resolveCron({ cron: "*/15 * * * *" })).toEqual({ cron: "*/15 * * * *", preset: "" });
  });
  it("throws if neither provided", () => {
    expect(() => resolveCron({})).toThrow("--every or --cron");
  });
  it("throws on invalid cron", () => {
    expect(() => resolveCron({ cron: "bad" })).toThrow("Invalid cron expression");
  });
});

describe("formatSchedule", () => {
  it("shows preset name when available", () => {
    expect(formatSchedule("0 9 * * 1-5", "weekdays")).toBe("weekdays");
  });
  it("shows raw cron when no preset", () => {
    expect(formatSchedule("*/15 * * * *", "")).toBe("*/15 * * * *");
  });
});

describe("nextRun", () => {
  it("returns a Date in the future", () => {
    const next = nextRun("* * * * *");
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });
  it("returns within 60s for minutely cron", () => {
    const next = nextRun("* * * * *");
    const diffMs = next.getTime() - Date.now();
    expect(diffMs).toBeLessThanOrEqual(60_000);
    expect(diffMs).toBeGreaterThan(0);
  });
});

describe("cronToOnCalendar", () => {
  it("converts daily at 9am", () => {
    expect(cronToOnCalendar("0 9 * * *")).toBe("*-*-* 09:00:00");
  });
  it("converts weekdays at 9am", () => {
    const result = cronToOnCalendar("0 9 * * 1-5");
    expect(result).toBe("Mon,Tue,Wed,Thu,Fri *-*-* 09:00:00");
  });
  it("converts hourly", () => {
    expect(cronToOnCalendar("0 * * * *")).toBe("*-*-* *:00:00");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/cron.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement cron utilities**

```typescript
// packages/agency-lang/lib/cli/schedule/cron.ts

export const PRESETS: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekdays: "0 9 * * 1-5",
  weekly: "0 9 * * 1",
};

export function presetToCron(preset: string): string {
  const cron = PRESETS[preset];
  if (!cron) {
    throw new Error(
      `Unknown preset "${preset}". Valid presets: ${Object.keys(PRESETS).join(", ")}`,
    );
  }
  return cron;
}

export function validateCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const fieldPattern = /^(\*|[0-9]+(-[0-9]+)?(\/[0-9]+)?)(,(\*|[0-9]+(-[0-9]+)?(\/[0-9]+)?))*$/;
  return fields.every((f) => fieldPattern.test(f));
}

export function resolveCron(opts: { every?: string; cron?: string }): { cron: string; preset: string } {
  if (opts.every) {
    return { cron: presetToCron(opts.every), preset: opts.every };
  }
  if (opts.cron) {
    if (!validateCron(opts.cron)) {
      throw new Error(
        `Invalid cron expression "${opts.cron}". Expected 5 fields: minute hour day-of-month month day-of-week. Example: "0 9 * * 1-5" (weekdays at 9am)`,
      );
    }
    return { cron: opts.cron, preset: "" };
  }
  throw new Error("Must provide --every or --cron to set a schedule.");
}

export function formatSchedule(cron: string, preset: string): string {
  return preset || cron;
}

export function nextRun(cronExpr: string): Date {
  const [minF, hourF, domF, monF, dowF] = cronExpr.trim().split(/\s+/);
  const candidate = new Date();
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < 527_040; i++) {
    if (
      matchField(minF, candidate.getMinutes()) &&
      matchField(hourF, candidate.getHours()) &&
      matchField(domF, candidate.getDate()) &&
      matchField(monF, candidate.getMonth() + 1) &&
      matchField(dowF, candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return candidate;
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function cronToOnCalendar(cron: string): string {
  const [min, hour, dom, mon, dow] = cron.split(/\s+/);

  const dowPart = dow === "*" ? "" : expandDow(dow);
  const datePart = `*-${field(mon)}-${field(dom)}`;
  const timePart = `${field(hour)}:${field(min)}:00`;

  return dowPart ? `${dowPart} ${datePart} ${timePart}` : `${datePart} ${timePart}`;
}

function expandDow(dow: string): string {
  if (dow.includes("-")) {
    const [lo, hi] = dow.split("-").map(Number);
    const days = [];
    for (let i = lo; i <= hi; i++) days.push(DOW_NAMES[i]);
    return days.join(",");
  }
  return DOW_NAMES[Number(dow)] || dow;
}

function field(f: string): string {
  if (f === "*") return "*";
  return f.padStart(2, "0");
}

function matchField(field: string, value: number): boolean {
  return field.split(",").some((part) => matchPart(part, value));
}

function matchPart(part: string, value: number): boolean {
  const [range, stepStr] = part.split("/");
  const step = stepStr ? parseInt(stepStr, 10) : 1;

  if (range === "*") return value % step === 0;

  if (range.includes("-")) {
    const [low, high] = range.split("-").map(Number);
    return value >= low && value <= high && (value - low) % step === 0;
  }

  return parseInt(range, 10) === value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/cron.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
git add packages/agency-lang/lib/cli/schedule/cron.ts packages/agency-lang/lib/cli/schedule/cron.test.ts
git commit -m "feat(schedule): add cron validation, presets, nextRun, and systemd conversion"
```

---

### Task 3: Typestache Templates

**Files:**
- Create: `packages/agency-lang/lib/templates/cli/schedule/runScript.mustache`
- Create: `packages/agency-lang/lib/templates/cli/schedule/plist.mustache`
- Create: `packages/agency-lang/lib/templates/cli/schedule/service.mustache`
- Create: `packages/agency-lang/lib/templates/cli/schedule/timer.mustache`

All multi-line config strings are expressed as Mustache templates. After creating them, run `pnpm run templates` to generate the typed `.ts` files.

- [ ] **Step 1: Create the run script template**

```mustache
{{! packages/agency-lang/lib/templates/cli/schedule/runScript.mustache }}
#!/bin/bash
set -e
cd "{{{agentDir:string}}}"
{{#hasEnvFile:boolean}}
export $(grep -v '^#' "{{{envFile:string}}}" | xargs)
{{/hasEnvFile}}
LOGFILE="{{{logDir:string}}}/$(date +%Y-%m-%dT%H-%M-%S).log"
{{{command:string}}} run "{{{agentFile:string}}}" >> "$LOGFILE" 2>&1

# Rotate: keep last 50 logs
cd "{{{logDir}}}"
ls -t *.log 2>/dev/null | tail -n +51 | xargs rm -f 2>/dev/null || true
```

- [ ] **Step 2: Create the plist template**

```mustache
{{! packages/agency-lang/lib/templates/cli/schedule/plist.mustache }}
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agency.schedule.{{{name:string}}}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>{{{runScriptPath:string}}}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{{{agentDir:string}}}</string>
  <key>StartCalendarInterval</key>
  <dict>
{{{intervals:string}}}
  </dict>
  <key>StandardOutPath</key>
  <string>{{{logDir:string}}}/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>{{{logDir:string}}}/launchd-stderr.log</string>
</dict>
</plist>
```

- [ ] **Step 3: Create the systemd service template**

```mustache
{{! packages/agency-lang/lib/templates/cli/schedule/service.mustache }}
[Unit]
Description=Agency scheduled agent: {{{name:string}}}

[Service]
Type=oneshot
WorkingDirectory={{{agentDir:string}}}
ExecStart=/bin/bash {{{runScriptPath:string}}}
```

- [ ] **Step 4: Create the systemd timer template**

```mustache
{{! packages/agency-lang/lib/templates/cli/schedule/timer.mustache }}
[Unit]
Description=Timer for agency-schedule-{{{name:string}}}

[Timer]
OnCalendar={{{onCalendar:string}}}
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: Compile templates**

Run: `pnpm run templates`
Expected: Generates `.ts` files alongside each `.mustache` file.

- [ ] **Step 6: Commit**

```
git add packages/agency-lang/lib/templates/cli/schedule/
git commit -m "feat(schedule): add typestache templates for plist, systemd units, and run script"
```

---

### Task 4: Backend Abstraction and Implementations

**Files:**
- Create: `packages/agency-lang/lib/cli/schedule/backends/index.ts`
- Create: `packages/agency-lang/lib/cli/schedule/backends/launchd.ts`
- Create: `packages/agency-lang/lib/cli/schedule/backends/systemd.ts`
- Create: `packages/agency-lang/lib/cli/schedule/backends/crontab.ts`
- Create: `packages/agency-lang/lib/cli/schedule/backends/backends.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fs from "fs";
import { LaunchdBackend } from "../schedule/backends/launchd.js";
import { CrontabBackend } from "../schedule/backends/crontab.js";
import { detectBackend } from "../schedule/backends/index.js";
import type { ScheduleEntry } from "../schedule/registry.js";

vi.mock("child_process");
vi.mock("fs");

const mockEntry: ScheduleEntry = {
  name: "test-agent",
  agentFile: "/home/user/project/agent.agency",
  cron: "0 9 * * *",
  preset: "daily",
  envFile: "/home/user/project/.env",
  command: "agency",
  logDir: "/home/user/.agency/schedules/test-agent/logs",
  createdAt: "2026-05-06T10:00:00-07:00",
  backend: "launchd",
};

// Mock writeRunScript so backends don't actually write files
vi.mock("../schedule/backends/writeRunScript.js", () => ({
  writeRunScript: () => "/mock/path/run.sh",
}));

describe("LaunchdBackend", () => {
  const backend = new LaunchdBackend();

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    vi.mocked(childProcess.execSync).mockImplementation(() => Buffer.from(""));
  });

  afterEach(() => vi.restoreAllMocks());

  it("install writes a plist and calls launchctl load", () => {
    backend.install(mockEntry);
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const plistPath = writeCall[0] as string;
    const plistContent = writeCall[1] as string;
    expect(plistPath).toContain("com.agency.schedule.test-agent.plist");
    expect(plistContent).toContain("<key>StartCalendarInterval</key>");
    expect(plistContent).toContain("<key>Hour</key>");
    expect(plistContent).toContain("<integer>9</integer>");
    expect(vi.mocked(childProcess.execSync)).toHaveBeenCalledWith(
      expect.stringContaining("launchctl load"),
    );
  });

  it("uninstall calls launchctl unload and deletes plist", () => {
    backend.uninstall("test-agent");
    expect(vi.mocked(childProcess.execSync)).toHaveBeenCalledWith(
      expect.stringContaining("launchctl unload"),
    );
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
  });
});

describe("CrontabBackend", () => {
  const backend = new CrontabBackend();

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
      if (typeof cmd === "string" && cmd.includes("crontab -l")) {
        return Buffer.from("# existing crontab\n");
      }
      return Buffer.from("");
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("install writes crontab with agency marker", () => {
    backend.install(mockEntry);
    const calls = vi.mocked(childProcess.execSync).mock.calls;
    const installCall = calls.find(
      (c) => c[1] && typeof c[1] === "object" && "input" in c[1],
    );
    expect(installCall).toBeDefined();
    const input = (installCall![1] as any).input as string;
    expect(input).toContain("# agency:test-agent");
  });

  it("uninstall removes crontab line matching agency marker", () => {
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
      if (typeof cmd === "string" && cmd.includes("crontab -l")) {
        return Buffer.from(
          "0 * * * * other-job\n0 9 * * * /path/run.sh # agency:test-agent\n",
        );
      }
      return Buffer.from("");
    });
    backend.uninstall("test-agent");
    const calls = vi.mocked(childProcess.execSync).mock.calls;
    const writeCall = calls.find(
      (c) => c[1] && typeof c[1] === "object" && "input" in c[1],
    );
    const input = (writeCall![1] as any).input as string;
    expect(input).not.toContain("agency:test-agent");
    expect(input).toContain("other-job");
  });
});

describe("detectBackend", () => {
  it("returns launchd on darwin", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(detectBackend()).toBe("launchd");
    Object.defineProperty(process, "platform", { value: original });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/backends/backends.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement backend interface and factory**

```typescript
// packages/agency-lang/lib/cli/schedule/backends/index.ts
import { execSync } from "child_process";
import type { ScheduleEntry } from "../registry.js";
import { LaunchdBackend } from "./launchd.js";
import { SystemdBackend } from "./systemd.js";
import { CrontabBackend } from "./crontab.js";

export type ScheduleBackend = {
  install(entry: ScheduleEntry): void;
  uninstall(name: string): void;
};

export function detectBackend(): "launchd" | "systemd" | "crontab" {
  if (process.platform === "darwin") return "launchd";
  try {
    execSync("which systemctl", { stdio: "pipe" });
    return "systemd";
  } catch {
    return "crontab";
  }
}

export function getBackend(type: "launchd" | "systemd" | "crontab"): ScheduleBackend {
  switch (type) {
    case "launchd": return new LaunchdBackend();
    case "systemd": return new SystemdBackend();
    case "crontab": return new CrontabBackend();
  }
}

export { LaunchdBackend } from "./launchd.js";
export { SystemdBackend } from "./systemd.js";
export { CrontabBackend } from "./crontab.js";
```

- [ ] **Step 4: Implement shared writeRunScript helper**

All backends need to write a `run.sh` file. This helper uses the typestache template:

```typescript
// packages/agency-lang/lib/cli/schedule/backends/writeRunScript.ts
import * as fs from "fs";
import * as path from "path";
import type { ScheduleEntry } from "../registry.js";
import renderRunScript from "@/templates/cli/schedule/runScript.js";

export function writeRunScript(entry: ScheduleEntry): string {
  const scriptDir = path.dirname(entry.logDir);
  const scriptPath = path.join(scriptDir, "run.sh");

  const content = renderRunScript({
    agentDir: path.dirname(entry.agentFile),
    hasEnvFile: !!entry.envFile,
    envFile: entry.envFile,
    logDir: entry.logDir,
    command: entry.command,
    agentFile: entry.agentFile,
  });

  if (!fs.existsSync(scriptDir)) fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}
```

- [ ] **Step 5: Implement LaunchdBackend**

```typescript
// packages/agency-lang/lib/cli/schedule/backends/launchd.ts
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ScheduleEntry } from "../registry.js";
import type { ScheduleBackend } from "./index.js";
import { writeRunScript } from "./writeRunScript.js";
import renderPlist from "@/templates/cli/schedule/plist.js";

const PLIST_DIR = path.join(os.homedir(), "Library", "LaunchAgents");

function plistPath(name: string): string {
  return path.join(PLIST_DIR, `com.agency.schedule.${name}.plist`);
}

function buildIntervals(cron: string): string {
  const [minute, hour, dom, month, dow] = cron.split(/\s+/);
  return [
    minute !== "*" && `      <key>Minute</key>\n      <integer>${minute}</integer>`,
    hour !== "*" && `      <key>Hour</key>\n      <integer>${hour}</integer>`,
    dom !== "*" && `      <key>Day</key>\n      <integer>${dom}</integer>`,
    month !== "*" && `      <key>Month</key>\n      <integer>${month}</integer>`,
    dow !== "*" && `      <key>Weekday</key>\n      <integer>${dow}</integer>`,
  ].filter(Boolean).join("\n");
}

export class LaunchdBackend implements ScheduleBackend {
  install(entry: ScheduleEntry): void {
    const runScriptPath = writeRunScript(entry);
    const plist = renderPlist({
      name: entry.name,
      runScriptPath,
      agentDir: path.dirname(entry.agentFile),
      intervals: buildIntervals(entry.cron),
      logDir: entry.logDir,
    });
    const dest = plistPath(entry.name);

    if (!fs.existsSync(PLIST_DIR)) fs.mkdirSync(PLIST_DIR, { recursive: true });
    if (!fs.existsSync(entry.logDir)) fs.mkdirSync(entry.logDir, { recursive: true });

    fs.writeFileSync(dest, plist);
    execSync(`launchctl load "${dest}"`);
  }

  uninstall(name: string): void {
    const dest = plistPath(name);
    if (fs.existsSync(dest)) {
      try { execSync(`launchctl unload "${dest}"`); } catch {}
      fs.unlinkSync(dest);
    }
  }
}
```

- [ ] **Step 6: Implement SystemdBackend**

```typescript
// packages/agency-lang/lib/cli/schedule/backends/systemd.ts
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ScheduleEntry } from "../registry.js";
import type { ScheduleBackend } from "./index.js";
import { writeRunScript } from "./writeRunScript.js";
import { cronToOnCalendar } from "../cron.js";
import renderService from "@/templates/cli/schedule/service.js";
import renderTimer from "@/templates/cli/schedule/timer.js";

const UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");

function unitName(name: string): string {
  return `agency-schedule-${name}`;
}

export class SystemdBackend implements ScheduleBackend {
  install(entry: ScheduleEntry): void {
    const runScriptPath = writeRunScript(entry);
    const unit = unitName(entry.name);

    const service = renderService({
      name: entry.name,
      agentDir: path.dirname(entry.agentFile),
      runScriptPath,
    });
    const timer = renderTimer({
      name: entry.name,
      onCalendar: cronToOnCalendar(entry.cron),
    });

    if (!fs.existsSync(UNIT_DIR)) fs.mkdirSync(UNIT_DIR, { recursive: true });
    if (!fs.existsSync(entry.logDir)) fs.mkdirSync(entry.logDir, { recursive: true });

    fs.writeFileSync(path.join(UNIT_DIR, `${unit}.service`), service);
    fs.writeFileSync(path.join(UNIT_DIR, `${unit}.timer`), timer);
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable --now ${unit}.timer`);
  }

  uninstall(name: string): void {
    const unit = unitName(name);
    try { execSync(`systemctl --user disable --now ${unit}.timer`); } catch {}
    const servicePath = path.join(UNIT_DIR, `${unit}.service`);
    const timerPath = path.join(UNIT_DIR, `${unit}.timer`);
    if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
    if (fs.existsSync(timerPath)) fs.unlinkSync(timerPath);
    try { execSync("systemctl --user daemon-reload"); } catch {}
  }
}
```

- [ ] **Step 7: Implement CrontabBackend**

```typescript
// packages/agency-lang/lib/cli/schedule/backends/crontab.ts
import { execSync } from "child_process";
import * as fs from "fs";
import type { ScheduleEntry } from "../registry.js";
import type { ScheduleBackend } from "./index.js";
import { writeRunScript } from "./writeRunScript.js";

function readCrontab(): string {
  try {
    return execSync("crontab -l", { stdio: ["pipe", "pipe", "pipe"] }).toString();
  } catch {
    return "";
  }
}

function writeCrontab(content: string): void {
  execSync("crontab -", { input: content });
}

function filterLines(crontab: string, name: string): string[] {
  return crontab.split("\n").filter((line) => !line.includes(`# agency:${name}`));
}

export class CrontabBackend implements ScheduleBackend {
  install(entry: ScheduleEntry): void {
    const runScriptPath = writeRunScript(entry);

    if (!fs.existsSync(entry.logDir)) {
      fs.mkdirSync(entry.logDir, { recursive: true });
    }

    const lines = filterLines(readCrontab(), entry.name);
    lines.push(`${entry.cron} /bin/bash "${runScriptPath}" # agency:${entry.name}`);
    const content = lines.filter((l) => l.trim() !== "").join("\n") + "\n";
    writeCrontab(content);
  }

  uninstall(name: string): void {
    const existing = readCrontab();
    if (!existing) return;
    const lines = filterLines(existing, name);
    const content = lines.filter((l) => l.trim() !== "").join("\n") + "\n";
    writeCrontab(content);
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/backends/backends.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```
git add packages/agency-lang/lib/cli/schedule/backends/ packages/agency-lang/lib/cli/schedule/runScript.ts
git commit -m "feat(schedule): add launchd, systemd, and crontab backends"
```

---

### Task 5: Main Schedule Module (add, list, remove, edit)

**Files:**
- Create: `packages/agency-lang/lib/cli/schedule/index.ts`
- Create: `packages/agency-lang/lib/cli/schedule/index.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { scheduleAdd, scheduleList, scheduleRemove, scheduleEdit } from "../schedule/index.js";

vi.mock("../schedule/backends/index.js", () => ({
  detectBackend: () => "launchd" as const,
  getBackend: () => ({
    install: vi.fn(),
    uninstall: vi.fn(),
  }),
}));

describe("scheduleAdd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sched-test-"));
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "node main() {}");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("adds a schedule with a preset", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].cron).toBe("0 9 * * *");
    expect(reg["agent"].preset).toBe("daily");
  });

  it("adds a schedule with a cron expression", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), cron: "*/15 * * * *", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].cron).toBe("*/15 * * * *");
    expect(reg["agent"].preset).toBe("");
  });

  it("uses custom name when provided", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", name: "custom", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["custom"]).toBeDefined();
  });

  it("stores env-file and command", () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "KEY=value");
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", envFile, command: "pnpm run agency", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].envFile).toBe(envFile);
    expect(reg["agent"].command).toBe("pnpm run agency");
  });

  it("throws if agent file does not exist", () => {
    expect(() => scheduleAdd({ file: path.join(tmpDir, "nope.agency"), every: "daily", baseDir: tmpDir })).toThrow("does not exist");
  });

  it("throws if cron expression is invalid", () => {
    expect(() => scheduleAdd({ file: path.join(tmpDir, "agent.agency"), cron: "bad", baseDir: tmpDir })).toThrow("Invalid cron expression");
  });

  it("throws if neither --every nor --cron is provided", () => {
    expect(() => scheduleAdd({ file: path.join(tmpDir, "agent.agency"), baseDir: tmpDir })).toThrow("--every or --cron");
  });
});

describe("scheduleList", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sched-test-"));
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "node main() {}");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("returns empty array when no schedules exist", () => {
    expect(scheduleList({ baseDir: tmpDir })).toEqual([]);
  });

  it("returns entries after adding", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    const result = scheduleList({ baseDir: tmpDir });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("agent");
  });
});

describe("scheduleRemove", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sched-test-"));
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "node main() {}");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("removes an existing schedule", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    scheduleRemove({ name: "agent", baseDir: tmpDir });
    expect(scheduleList({ baseDir: tmpDir })).toEqual([]);
  });

  it("throws if name does not exist", () => {
    expect(() => scheduleRemove({ name: "nope", baseDir: tmpDir })).toThrow("No schedule named");
  });
});

describe("scheduleEdit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sched-test-"));
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "node main() {}");
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("updates cron expression", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    scheduleEdit({ name: "agent", cron: "0 8 * * *", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].cron).toBe("0 8 * * *");
    expect(reg["agent"].preset).toBe("");
  });

  it("updates command while keeping other fields", () => {
    scheduleAdd({ file: path.join(tmpDir, "agent.agency"), every: "daily", baseDir: tmpDir });
    scheduleEdit({ name: "agent", command: "npx agency-lang", baseDir: tmpDir });
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, "schedules.json"), "utf-8"));
    expect(reg["agent"].command).toBe("npx agency-lang");
    expect(reg["agent"].cron).toBe("0 9 * * *");
  });

  it("throws if name does not exist", () => {
    expect(() => scheduleEdit({ name: "nope", baseDir: tmpDir })).toThrow("No schedule named");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/index.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the main schedule module**

```typescript
// packages/agency-lang/lib/cli/schedule/index.ts
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Registry, type ScheduleEntry } from "./registry.js";
import { resolveCron, formatSchedule, nextRun } from "./cron.js";
import { detectBackend, getBackend } from "./backends/index.js";

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
    throw new Error(
      `A schedule named "${name}" already exists. Use --name to pick a different name, or remove the existing one first.`,
    );
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

  if (registry.has(name)) backend.uninstall(name);
  registry.set(entry);

  try {
    backend.install(entry);
  } catch (err) {
    registry.remove(name);
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
    throw new Error(`No schedule named "${opts.name}". Run 'agency schedule list' to see available schedules.`);
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
    throw new Error(`No schedule named "${opts.name}". Run 'agency schedule list' to see available schedules.`);
  }

  if (opts.envFile && !fs.existsSync(opts.envFile)) {
    throw new Error(`Env file does not exist: ${opts.envFile}`);
  }

  // Only resolve cron if user provided new schedule options
  const { cron, preset } = (opts.every || opts.cron)
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
    registry.set(existing);
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/index.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
git add packages/agency-lang/lib/cli/schedule/index.ts packages/agency-lang/lib/cli/schedule/index.test.ts
git commit -m "feat(schedule): add, list, remove, edit commands with validation"
```

---

### Task 6: Wire Up Commander in agency.ts

**Files:**
- Modify: `packages/agency-lang/scripts/agency.ts`

- [ ] **Step 1: Add import at the top of `scripts/agency.ts`**

```typescript
import { scheduleAdd, scheduleList, scheduleRemove, scheduleEdit } from "@/cli/schedule/index.js";
```

- [ ] **Step 2: Add schedule subcommand in `createProgram()`**

Add after the `review` command block (around line 551):

```typescript
const scheduleCmd = program
  .command("schedule")
  .description("Manage scheduled agent runs");

scheduleCmd
  .command("add")
  .description("Schedule an agent to run on a recurring basis")
  .argument("<file>", "Path to .agency file")
  .option("--every <preset>", "Schedule preset: hourly, daily, weekdays, weekly")
  .option("--cron <expression>", "Cron expression (5 fields)")
  .option("--name <name>", "Schedule name (default: derived from filename)")
  .option("--env-file <path>", "Path to .env file")
  .option("--command <cmd>", "Command to run agency (default: agency)")
  .action(async (file: string, opts: {
    every?: string;
    cron?: string;
    name?: string;
    envFile?: string;
    command?: string;
  }) => {
    try {
      scheduleAdd({ file, ...opts });
      const name = opts.name || path.basename(file, ".agency");
      console.log(color.green(`Schedule "${name}" added successfully.`));
    } catch (err: any) {
      if (err.message.includes("already exists") && process.stdin.isTTY) {
        const confirmed = await promptOverwrite(opts.name || path.basename(file, ".agency"));
        if (confirmed) {
          scheduleAdd({ file, ...opts, force: true });
          console.log(color.green("Schedule overwritten successfully."));
        } else {
          console.log("Aborted.");
        }
      } else {
        console.error(color.red(err.message));
        process.exit(1);
      }
    }
  });

scheduleCmd
  .command("list")
  .alias("ls")
  .description("List all scheduled agents")
  .action(() => {
    const entries = scheduleList({});
    if (entries.length === 0) {
      console.log("No scheduled agents. Use 'agency schedule add' to create one.");
      return;
    }
    printScheduleTable(entries);
  });

scheduleCmd
  .command("remove")
  .alias("rm")
  .description("Remove a scheduled agent")
  .argument("<name>", "Name of the schedule to remove")
  .action((name: string) => {
    try {
      scheduleRemove({ name });
      console.log(color.green(`Schedule "${name}" removed.`));
    } catch (err: any) {
      console.error(color.red(err.message));
      process.exit(1);
    }
  });

scheduleCmd
  .command("edit")
  .description("Edit an existing scheduled agent")
  .argument("<name>", "Name of the schedule to edit")
  .option("--every <preset>", "Schedule preset: hourly, daily, weekdays, weekly")
  .option("--cron <expression>", "Cron expression (5 fields)")
  .option("--env-file <path>", "Path to .env file")
  .option("--command <cmd>", "Command to run agency")
  .action((name: string, opts: {
    every?: string;
    cron?: string;
    envFile?: string;
    command?: string;
  }) => {
    try {
      scheduleEdit({ name, ...opts });
      console.log(color.green(`Schedule "${name}" updated.`));
    } catch (err: any) {
      console.error(color.red(err.message));
      process.exit(1);
    }
  });
```

- [ ] **Step 3: Add helper functions (outside `createProgram`)**

```typescript
async function promptOverwrite(name: string): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`A schedule named "${name}" already exists. Overwrite? (y/n) `, resolve);
  });
  rl.close();
  return answer.toLowerCase() === "y";
}

function printScheduleTable(entries: { name: string; agentFile: string; schedule: string; nextRun: Date; broken: boolean }[]): void {
  const nameW = Math.max(4, ...entries.map((e) => e.name.length)) + 2;
  const agentW = Math.max(5, ...entries.map((e) => e.agentFile.length)) + 2;
  const schedW = Math.max(8, ...entries.map((e) => e.schedule.length)) + 2;

  console.log(
    "Name".padEnd(nameW) + "Agent".padEnd(agentW) + "Schedule".padEnd(schedW) + "Next Run",
  );
  for (const entry of entries) {
    const broken = entry.broken ? color.red(" [broken]") : "";
    const nextRunStr = entry.nextRun.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    console.log(
      entry.name.padEnd(nameW) +
      (entry.agentFile + broken).padEnd(agentW) +
      entry.schedule.padEnd(schedW) +
      nextRunStr,
    );
  }
}
```

- [ ] **Step 4: Build and verify CLI help**

Run: `make && pnpm run agency schedule --help`
Expected: Shows schedule subcommands (add, list, remove, edit)

- [ ] **Step 5: Commit**

```
git add packages/agency-lang/scripts/agency.ts
git commit -m "feat(schedule): wire up schedule subcommand in CLI"
```

---

### Task 7: Manual Integration Test

**Files:** None (manual verification)

- [ ] **Step 1: Run all schedule tests**

Run: `pnpm --filter agency-lang exec vitest run lib/cli/schedule/`
Expected: All tests pass across all test files.

- [ ] **Step 2: Manual smoke test (macOS)**

From the `packages/agency-lang/` directory:

```bash
echo 'node main() { print("hello from scheduled agent") }' > test-schedule.agency
pnpm run agency schedule add test-schedule.agency --every hourly --name test-schedule
pnpm run agency schedule list
pnpm run agency schedule edit test-schedule --every daily
pnpm run agency schedule list
pnpm run agency schedule remove test-schedule
pnpm run agency schedule list
rm test-schedule.agency
```

Verify:
- `add` creates a plist in `~/Library/LaunchAgents/com.agency.schedule.test-schedule.plist`
- `list` shows the entry with correct schedule and next run time
- `edit` updates the schedule
- `remove` cleans up the plist and registry

- [ ] **Step 3: Final commit**

```
git commit --allow-empty -m "feat(schedule): verified manual integration test"
```
