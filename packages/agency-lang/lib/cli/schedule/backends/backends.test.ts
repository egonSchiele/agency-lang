import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fs from "fs";
import { LaunchdBackend } from "./launchd.js";
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

describe("LaunchdBackend", () => {
  const backend = new LaunchdBackend();

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    vi.mocked(childProcess.execSync).mockImplementation(
      () => Buffer.from(""),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("install writes a plist and calls launchctl load", () => {
    backend.install(mockEntry);
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const plistPath = writeCall[0] as string;
    expect(plistPath).toContain("com.agency.schedule.test-agent.plist");
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
});

describe("detectBackend", () => {
  it("returns launchd on darwin", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(detectBackend()).toBe("launchd");
    Object.defineProperty(process, "platform", { value: original });
  });
});
