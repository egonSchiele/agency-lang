import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, realpathSync, statSync } from "fs";
import os from "os";
import path from "path";
import { nodeHost } from "../host/node/nodeHost.js";
import type { Host } from "../host/host.js";
import { safeDeleteDirectoryWithin } from "../utils.js";
import { ensureScratchDir, scratchDirPath, scratchId } from "./scratchDir.js";
import { builtinPolicy } from "./builtinPolicies.js";
import { checkPolicyExplicit, type PolicyDirs } from "./policy.js";
import { resolvePolicyDirs } from "./policyDirs.js";

/** A nodeHost whose temp folder and user id are the test's. */
function hostWith(args: { tempDir: string; userId?: string }): Host {
  const base = nodeHost();
  return {
    ...base,
    system: {
      ...base.system,
      tempDir: () => args.tempDir,
      userId: () => args.userId ?? base.system.userId(),
    },
  };
}

describe("scratchDirPath", () => {
  const host = hostWith({ tempDir: "/tmp/", userId: "1000" });

  it("is the same path for the same run id, and differs for another", () => {
    expect(scratchDirPath(host, "run-a")).toBe(scratchDirPath(host, "run-a"));
    expect(scratchDirPath(host, "run-a")).not.toBe(scratchDirPath(host, "run-b"));
  });

  it("is <temp>/agency-scratch-<user id>/<16 hex characters>", () => {
    expect(scratchDirPath(host, "run-a")).toMatch(/^\/tmp\/agency-scratch-1000\/[0-9a-f]{16}$/);
  });

  it("keeps a run id that holds path characters inside the parent", () => {
    for (const runId of ["../../Users/me/.agency-agent", "/etc", "a/b", "..", ""]) {
      expect(scratchId(runId), runId).toMatch(/^[0-9a-f]{16}$/);
      expect(scratchDirPath(host, runId), runId).toMatch(
        /^\/tmp\/agency-scratch-1000\/[0-9a-f]{16}$/,
      );
    }
  });
});

describe("ensureScratchDir", () => {
  it("creates the folder for this user alone, and a second call returns the same path", async () => {
    const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agency-scratch-test-")));
    try {
      const host = hostWith({ tempDir: temp });
      const first = await ensureScratchDir(host, "run-a");
      expect(first).toBe(scratchDirPath(host, "run-a"));
      expect(statSync(first).isDirectory()).toBe(true);
      expect(statSync(first).mode & 0o777).toBe(0o700);
      expect(await ensureScratchDir(host, "run-a")).toBe(first);
      const other = await ensureScratchDir(host, "run-b");
      expect(other).not.toBe(first);
      expect(existsSync(other)).toBe(true);
    } finally {
      safeDeleteDirectoryWithin(realpathSync(os.tmpdir()), temp);
    }
  });
});

describe("<scratch> in a policy, for a check made outside the run", () => {
  const temp = "/tmp";
  const host = hostWith({ tempDir: temp, userId: "1000" });
  const dirs = resolvePolicyDirs(host);
  const real = realpathSync(temp);
  const write = (dir: string, runId: string | undefined) => ({
    effect: "std::write",
    message: "m",
    data: { dir, filename: "out.log" },
    origin: "test",
    runId,
  });
  const recommended = builtinPolicy("recommended", "/home/me/proj")!;

  it("resolves the scratch parent once, as a real path", () => {
    expect(dirs.scratchParent).toBe(`${real}/agency-scratch-1000`);
  });

  it("approves a write in the folder of the run that raised the interrupt", () => {
    const own = `${real}/agency-scratch-1000/${scratchId("run-a")}`;
    expect(checkPolicyExplicit(recommended, write(own, "run-a"), dirs)).toEqual({
      type: "approve",
    });
    expect(checkPolicyExplicit(recommended, write(`${own}/sub`, "run-a"), dirs)).toEqual({
      type: "approve",
    });
  });

  it("does not approve a write in another run's folder", () => {
    const other = `${real}/agency-scratch-1000/${scratchId("run-b")}`;
    const decision = checkPolicyExplicit(recommended, write(other, "run-a"), dirs);
    expect(decision?.type).not.toBe("approve");
  });

  it("matches no scratch rule for an interrupt with no run id", () => {
    const own = `${real}/agency-scratch-1000/${scratchId("run-a")}`;
    const decision = checkPolicyExplicit(recommended, write(own, undefined), dirs);
    expect(decision?.type).not.toBe("approve");
  });
});

describe("<scratch> in a rule", () => {
  const dirs: PolicyDirs = {
    cwd: "/home/me/proj",
    agentHome: "/home/me/.agency-agent",
    home: "/home/me",
    agencyInstallDir: null,
    scratch: "/tmp/agency-scratch-1000/abc",
  };
  const intr = (effect: string, data: Record<string, string>) => ({
    effect,
    message: "m",
    data,
    origin: "test",
  });

  it("resolves in a remove's target", () => {
    const policy = { "std::remove": [{ match: { target: "<scratch>/**" }, action: "approve" }] };
    expect(
      checkPolicyExplicit(
        policy as never,
        intr("std::remove", { target: "/tmp/agency-scratch-1000/abc/x.log" }),
        dirs,
      ),
    ).toEqual({ type: "approve" });
  });

  it("is left as written, and matches nothing, when there is no scratch folder", () => {
    const policy = { "std::write": [{ match: { dir: "<scratch>" }, action: "approve" }] };
    const none: PolicyDirs = { ...dirs, scratch: null };
    expect(
      checkPolicyExplicit(
        policy as never,
        intr("std::write", { dir: "/tmp/agency-scratch-1000/abc" }),
        none,
      ),
    ).toBeNull();
  });

  it("is filled in a reject message, with the other named placeholders", () => {
    const policy = {
      "std::write": [
        { action: "reject", rejectMessage: "Use <scratch>, not <agent-home> or <home>." },
      ],
    };
    expect(checkPolicyExplicit(policy as never, intr("std::write", { dir: "/x" }), dirs)).toEqual({
      type: "reject",
      message: "Use /tmp/agency-scratch-1000/abc, not /home/me/.agency-agent or /home/me.",
      value: "Use /tmp/agency-scratch-1000/abc, not /home/me/.agency-agent or /home/me.",
    });
  });

  it("stays in a reject message when there is no scratch folder", () => {
    const policy = { "std::write": [{ action: "reject", rejectMessage: "Use <scratch>." }] };
    const none: PolicyDirs = { ...dirs, scratch: null };
    expect(checkPolicyExplicit(policy as never, intr("std::write", { dir: "/x" }), none)).toEqual({
      type: "reject",
      message: "Use <scratch>.",
      value: "Use <scratch>.",
    });
  });
});

describe("the scratch rules in the built-in policies", () => {
  const scratch = "/tmp/agency-scratch-1000/abc";
  const dirsIn = (cwd: string): PolicyDirs => ({
    cwd,
    agentHome: "/home/me/.agency-agent",
    home: "/home/me",
    agencyInstallDir: null,
    scratch,
  });
  const ask = (effect: string, data: Record<string, string>) => ({
    effect,
    message: "m",
    data,
    origin: "test",
  });
  const message = `Write temporary files under ${scratch} instead.`;
  const rejected = { type: "reject", message, value: message };

  it("recommended: writes", () => {
    const policy = builtinPolicy("recommended", "/home/me/proj")!;
    const dirs = dirsIn("/home/me/proj");
    const write = (dir: string) => checkPolicyExplicit(policy, ask("std::write", { dir }), dirs);
    expect(write(scratch)).toEqual({ type: "approve" });
    expect(write(`${scratch}/sub`)).toEqual({ type: "approve" });
    expect(write("/tmp")).toEqual(rejected);
    expect(write("/private/tmp/x")).toEqual(rejected);
    expect(write("/home/me/proj")).toEqual({ type: "propagate" });
    expect(write("/home/me/elsewhere")).toBeNull();
  });

  it("recommended: a project under /tmp still prompts for its own writes", () => {
    const policy = builtinPolicy("recommended", "/tmp/proj")!;
    const decision = checkPolicyExplicit(
      policy,
      ask("std::write", { dir: "/tmp/proj/src" }),
      dirsIn("/tmp/proj"),
    );
    expect(decision).toEqual({ type: "propagate" });
  });

  it("recommended: reads, mkdir, and remove", () => {
    const policy = builtinPolicy("recommended", "/home/me/proj")!;
    const dirs = dirsIn("/home/me/proj");
    const check = (effect: string, data: Record<string, string>) =>
      checkPolicyExplicit(policy, ask(effect, data), dirs);
    expect(check("std::read", { dir: scratch, filename: "out.log" })).toEqual({ type: "approve" });
    expect(check("std::grep", { dir: `${scratch}/sub` })).toEqual({ type: "approve" });
    expect(check("std::ls", { dir: scratch })).toEqual({ type: "approve" });
    // A read elsewhere in /tmp is left to the user: they may have asked for it.
    expect(check("std::read", { dir: "/tmp", filename: "crash.log" })).toBeNull();
    expect(check("std::mkdir", { dir: `${scratch}/sub` })).toEqual({ type: "approve" });
    expect(check("std::remove", { target: `${scratch}/x.log` })).toEqual({ type: "approve" });
    expect(check("std::remove", { target: "/tmp/x.log" })).toBeNull();
    expect(check("std::edit", { dir: scratch, filename: "a" })).toEqual({ type: "approve" });
  });

  it("recommended: with no scratch folder, the message keeps the placeholder", () => {
    const policy = builtinPolicy("recommended", "/home/me/proj")!;
    const dirs: PolicyDirs = { ...dirsIn("/home/me/proj"), scratch: null };
    expect(checkPolicyExplicit(policy, ask("std::write", { dir: scratch }), dirs)).toEqual({
      type: "reject",
      message: "Write temporary files under <scratch> instead.",
      value: "Write temporary files under <scratch> instead.",
    });
  });

  it("with-writes: the launch folder wins over the /tmp reject, and the policy files still prompt", () => {
    const inTmp = builtinPolicy("with-writes", "/tmp/proj")!;
    expect(
      checkPolicyExplicit(inTmp, ask("std::write", { dir: "/tmp/proj/src" }), dirsIn("/tmp/proj")),
    ).toEqual({ type: "approve" });
    const policy = builtinPolicy("with-writes", "/home/me/proj")!;
    const dirs = dirsIn("/home/me/proj");
    expect(checkPolicyExplicit(policy, ask("std::write", { dir: "/tmp/x" }), dirs)).toEqual(
      rejected,
    );
    expect(checkPolicyExplicit(policy, ask("std::write", { dir: scratch }), dirs)).toEqual({
      type: "approve",
    });
    expect(
      checkPolicyExplicit(
        policy,
        ask("std::write", { dir: "/home/me/.agency-agent", filename: "policy.json" }),
        dirs,
      ),
    ).toEqual({ type: "propagate" });
  });
});
