import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "fs";
import os from "os";
import path from "path";
import { resolvePolicyDirs } from "./policyDirs.js";
import { checkPolicy } from "./policy.js";
import { nodeHost } from "../host/nodeHost.js";
import { RuntimeContext } from "./state/context.js";
import type { Host } from "../host/host.js";

/** A nodeHost whose working directory, home, and variables are the test's. */
function hostWith(args: { cwd?: string; agentHome?: string }): Host {
  const base = nodeHost();
  return {
    ...base,
    system: { ...base.system, cwd: () => args.cwd ?? base.system.cwd() },
    settings: {
      ...base.settings,
      read: (name) =>
        name === "AGENCY_AGENT_HOME" ? (args.agentHome ?? null) : base.settings.read(name),
    },
  };
}

const write = (dir: string) => ({
  effect: "std::write",
  message: "m",
  data: { dir, filename: "out.txt" },
  origin: "std::fs",
});

describe("resolvePolicyDirs", () => {
  it("keeps a working directory that does not exist as written, and `.` still matches it", () => {
    const missing = "/nonexistent-policy-cwd*";
    const dirs = resolvePolicyDirs(hostWith({ cwd: missing }));
    expect(dirs.cwd).toBe(missing);
    const policy = { "std::write": [{ match: { dir: "." }, action: "approve" as const }] };
    expect(checkPolicy(policy, write(missing), dirs).type).toBe("approve");
    expect(checkPolicy(policy, write("/nonexistent-policy-cwdX"), dirs).type).toBe("propagate");
  });

  it("resolves a symlinked working directory to its real path", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "policy-dirs-"));
    try {
      const real = path.join(base, "real");
      mkdirSync(real);
      const link = path.join(base, "link");
      symlinkSync(real, link);
      const dirs = resolvePolicyDirs(hostWith({ cwd: link }));
      expect(dirs.cwd).toBe(realpathSync(real));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("an agent home created after the global context is built is seen by the next run", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "policy-dirs-"));
    try {
      // macOS keeps os.tmpdir() behind a symlink, so the real path differs
      // from the lexical one. Elsewhere the two are the same string and the
      // test still holds.
      const home = path.join(base, "agent-home");
      const realHome = path.join(realpathSync(base), "agent-home");
      const host = hostWith({ agentHome: home });
      const ctx = new RuntimeContext({
        statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false },
        smoltalkDefaults: {},
        dirname: base,
        host,
      });
      // Not created yet: the existing parent is real, the tail is lexical,
      // which is how a file effect would spell it once it exists.
      expect(ctx.policyDirs.agentHome).toBe(realHome);

      mkdirSync(home);
      // A run started after the directory exists resolves it again.
      const execCtx = await ctx.createExecutionContext({ runId: "r1" });
      expect(execCtx.policyDirs.agentHome).toBe(realHome);
      expect(realpathSync(home)).toBe(realHome);
      const policy = {
        "std::write": [{ match: { dir: "<agent-home>" }, action: "approve" as const }],
      };
      expect(checkPolicy(policy, write(realpathSync(home)), execCtx.policyDirs).type).toBe(
        "approve",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("finds the install directory", () => {
    const dirs = resolvePolicyDirs(nodeHost());
    expect(dirs.agencyInstallDir).not.toBeNull();
  });
});
