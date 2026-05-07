import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fs from "fs";
import { LaunchdBackend, buildIntervals } from "./launchd.js";
import { SystemdBackend } from "./systemd.js";
import { CrontabBackend } from "./crontab.js";
import { detectBackend } from "./index.js";
import type { ScheduleEntry } from "../registry.js";

vi.mock("child_process");
vi.mock("fs");

vi.mock("./writeRunScript.js", () => ({
  writeRunScript: () => "/mock/path/run.sh",
}));

vi.mock("@/templates/cli/schedule/plist.js", () => ({
  default: (args: any) => `<plist>${args.name}</plist>`,
}));

vi.mock("@/templates/cli/schedule/service.js", () => ({
  default: (args: any) => `[Service] ${args.name}`,
}));

vi.mock("@/templates/cli/schedule/timer.js", () => ({
  default: (args: any) => `[Timer] ${args.name}`,
}));

const mockEntry: ScheduleEntry = {
  name: "test-agent",
  agentFile: "/home/user/project/agent.agency",
  cron: "0 9 * * *",
  preset: "daily",
  envFile: "/home/user/project/.env",
  logDir: "/home/user/.agency/schedules/test-agent/logs",
  createdAt: "2026-05-06T10:00:00-07:00",
  backend: "launchd",
};

describe("LaunchdBackend", () => {
  const backend = new LaunchdBackend();

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    vi.mocked(childProcess.execFileSync).mockImplementation(
      () => Buffer.from(""),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("install writes a plist and calls launchctl load", () => {
    backend.install(mockEntry);
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const plistPath = writeCall[0] as string;
    expect(plistPath).toContain("com.agency.schedule.test-agent.plist");
    expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledWith(
      "launchctl",
      ["load", expect.stringContaining("com.agency.schedule.test-agent.plist")],
    );
  });

  it("uninstall calls launchctl unload and deletes plist", () => {
    backend.uninstall("test-agent");
    expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledWith(
      "launchctl",
      ["unload", expect.stringContaining("com.agency.schedule.test-agent.plist")],
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
    vi.mocked(childProcess.execSync).mockReset();
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

  it("uninstall does not remove similar names", () => {
    vi.mocked(childProcess.execSync).mockReset();
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
      if (typeof cmd === "string" && cmd.includes("crontab -l")) {
        return Buffer.from(
          "0 9 * * * /path/run.sh # agency:foo\n0 9 * * * /path/run2.sh # agency:foo-bar\n",
        );
      }
      return Buffer.from("");
    });
    backend.uninstall("foo");
    const calls = vi.mocked(childProcess.execSync).mock.calls;
    const writeCall = calls.find(
      (c) => c[1] && typeof c[1] === "object" && "input" in c[1],
    );
    const input = (writeCall![1] as any).input as string;
    expect(input).not.toContain("# agency:foo\n");
    expect(input).toContain("# agency:foo-bar");
  });
});

describe("SystemdBackend", () => {
  const backend = new SystemdBackend();

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    vi.mocked(childProcess.execFileSync).mockImplementation(
      () => Buffer.from(""),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("install writes service and timer files and enables timer", () => {
    backend.install(mockEntry);
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const paths = writeCalls.map((c) => c[0] as string);
    expect(paths.some((p) => p.endsWith("agency-schedule-test-agent.service"))).toBe(true);
    expect(paths.some((p) => p.endsWith("agency-schedule-test-agent.timer"))).toBe(true);
    expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "enable", "--now", "agency-schedule-test-agent.timer"],
    );
  });

  it("uninstall disables timer and deletes unit files", () => {
    backend.uninstall("test-agent");
    expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "disable", "--now", "agency-schedule-test-agent.timer"],
    );
  });
});

describe("buildIntervals", () => {
  it("generates single dict for simple cron", () => {
    const result = buildIntervals("0 9 * * *");
    expect(result).toContain("<dict>");
    expect(result).toContain("<key>Minute</key>");
    expect(result).toContain("<integer>0</integer>");
    expect(result).toContain("<key>Hour</key>");
    expect(result).toContain("<integer>9</integer>");
    expect(result).not.toContain("<array>");
  });

  it("generates array of dicts for weekday range", () => {
    const result = buildIntervals("0 9 * * 1-5");
    expect(result).toContain("<array>");
    // Should have 5 dicts, one per weekday
    const dictCount = (result.match(/<dict>/g) || []).length;
    expect(dictCount).toBe(5);
    expect(result).toContain("<key>Weekday</key>");
    for (let i = 1; i <= 5; i++) {
      expect(result).toContain(`<integer>${i}</integer>`);
    }
  });

  it("expands */15 in minute field", () => {
    const result = buildIntervals("*/15 * * * *");
    expect(result).toContain("<array>");
    const dictCount = (result.match(/<dict>/g) || []).length;
    expect(dictCount).toBe(4); // 0, 15, 30, 45
    expect(result).toContain("<integer>0</integer>");
    expect(result).toContain("<integer>15</integer>");
    expect(result).toContain("<integer>30</integer>");
    expect(result).toContain("<integer>45</integer>");
  });

  it("handles wildcard fields by omitting them", () => {
    const result = buildIntervals("* * * * 1");
    // Only Weekday should be set, no Minute/Hour/Day/Month
    expect(result).toContain("<key>Weekday</key>");
    expect(result).not.toContain("<key>Minute</key>");
    expect(result).not.toContain("<key>Hour</key>");
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
