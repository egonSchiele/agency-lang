import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_COMMAND_BYTES, runCommandInSpawn } from "./spawnRunner.js";
import type { RunLimits } from "@/runtime/ipc.js";

const LIMITS: RunLimits = {
  wallClock: 10_000,
  memory: 256 * 1024 * 1024,
  ipcPayload: 1024,
  stdout: 1024 * 1024,
};

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync: mkdtemp paths sit outside any project root, which safeDelete
  // refuses by design. Same reasoning as runArtifacts.ts.
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "spawnrunner-"));
  dirs.push(d);
  return d;
}

function base(overrides: Partial<Parameters<typeof runCommandInSpawn>[0]>): Parameters<typeof runCommandInSpawn>[0] {
  return {
    argv: ["node", "-e", ""],
    cwd: tmp(),
    statelogPath: "/tmp/unused-statelog.jsonl",
    traceId: "trace-test",
    pipeOutput: false,
    limits: LIMITS,
    maxCostUsd: 50,
    ...overrides,
  };
}

describe("runCommandInSpawn", () => {
  it("spawns in the workdir with the statelog handoff and trace id in the env", async () => {
    const cwd = tmp();
    const outFile = path.join(cwd, "probe.json");
    const script = `require("fs").writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      cwd: process.cwd(),
      overrides: process.env.AGENCY_CONFIG_OVERRIDES,
      traceId: process.env.AGENCY_TRACE_ID,
      nodeOptions: process.env.NODE_OPTIONS,
    }))`;

    const result = await runCommandInSpawn(base({ argv: ["node", "-e", script], cwd, statelogPath: "/x/statelog.jsonl" }));

    expect(result).toEqual({ ok: true });
    const probe = JSON.parse(fs.readFileSync(outFile, "utf8"));
    expect(fs.realpathSync(probe.cwd)).toBe(fs.realpathSync(cwd));
    expect(JSON.parse(probe.overrides)).toEqual({ observability: true, log: { logFile: "/x/statelog.jsonl" } });
    expect(probe.traceId).toBe("trace-test");
    expect(probe.nodeOptions).toContain("--max-old-space-size=256");
  });

  it("drains large output without blocking, even when not piping", async () => {
    // ~1 MB to stdout: an unread pipe would block at ~64 KB and time out.
    const script = `const chunk = "x".repeat(65536); for (let i = 0; i < 16; i++) process.stdout.write(chunk);`;
    const result = await runCommandInSpawn(base({ argv: ["node", "-e", script] }));
    expect(result).toEqual({ ok: true });
  });

  it("kills on wall clock and names the limit plus the interactive hint", async () => {
    const result = await runCommandInSpawn(base({
      argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
      limits: { ...LIMITS, wallClock: 300 },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/wall clock limit exceeded/);
      expect(result.errorMessage).toMatch(/one-shot/);
    }
  });

  it("names the missing executable on ENOENT", async () => {
    const result = await runCommandInSpawn(base({ argv: ["definitely-not-a-real-binary-xyz", "arg"] }));
    expect(result).toEqual({ ok: false, errorMessage: `command not found: "definitely-not-a-real-binary-xyz"` });
  });

  it("rejects an oversized substituted command before spawning", async () => {
    const result = await runCommandInSpawn(base({ argv: ["node", "-e", "x".repeat(MAX_COMMAND_BYTES + 1)] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorMessage).toMatch(/over the .*-byte cap/);
  });

  it("maps a non-zero exit to an error carrying the stderr tail", async () => {
    const result = await runCommandInSpawn(base({
      argv: ["node", "-e", `process.stderr.write("boom detail"); process.exit(3)`],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/exited with code 3/);
      expect(result.errorMessage).toMatch(/boom detail/);
    }
  });

  it("wall clock kills the whole process TREE — a grandchild holding the pipes must not outlive the limit", async () => {
    // The observed escape: the command is a CLI wrapper whose grandchild
    // does the work with inherited stdio. Killing only the wrapper left the
    // grandchild running (and spending) for 8 more minutes, pipes open,
    // settle never firing until Ctrl-C. Group-kill closes the hole: this
    // settles at ~wallClock, not at the grandchild's 60s sleep.
    const script = `
      const { spawn } = require("child_process");
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
      grandchild.on("exit", () => process.exit(0));
    `;
    const startedAt = Date.now();
    const result = await runCommandInSpawn(base({
      argv: ["node", "-e", script],
      limits: { ...LIMITS, wallClock: 500 },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorMessage).toMatch(/wall clock limit exceeded/);
    // settled promptly after the limit (grace is 5s; the sleep was 60s)
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it("kills a run whose statelog cost passes the cap, naming the spend", async () => {
    const cwd = tmp();
    const statelogPath = path.join(cwd, "statelog.jsonl");
    // The child writes two promptCompletion events ($0.30 + $0.40 > $0.50 cap)
    // to its statelog, then sleeps; the tailer must catch it and kill.
    const script = `
      const fs = require("fs");
      const line = (c) => JSON.stringify({ data: { type: "promptCompletion", cost: { totalCost: c } } }) + "\\n";
      fs.appendFileSync(${JSON.stringify(statelogPath)}, line(0.3));
      fs.appendFileSync(${JSON.stringify(statelogPath)}, line(0.4));
      setTimeout(() => {}, 30000);
    `;
    const result = await runCommandInSpawn(base({
      argv: ["node", "-e", script],
      cwd,
      statelogPath,
      maxCostUsd: 0.5,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/cost cap exceeded: \$0\.70 spent, cap \$0\.50/);
    }
  }, 15_000);

  it("holds a SIGINT-forwarding listener exactly while the command runs", async () => {
    const before = process.listenerCount("SIGINT");
    const pending = runCommandInSpawn(base({ argv: ["node", "-e", "setTimeout(() => {}, 200)"] }));
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    await pending;
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
