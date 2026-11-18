import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { safeDeleteDirectoryWithin } from "../../utils.js";
import { nodeHost } from "../../host/node/nodeHost.js";
import { RuntimeContext } from "./context.js";

// The per-invocation override reaches a run through createExecutionContext: the
// resolver has already projected the allow-list into `contextOverride`, and this
// method applies it over the frozen parent for that one child only.
function makeParent() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://base",
      apiKey: "base-key",
      projectId: "base-proj",
      debugMode: false,
      observability: false,
    },
    smoltalkDefaults: {},
    dirname: "/project",
    budget: { maxCost: 5, maxTimeMs: 60_000 },
    maxCallDepth: 100,
    failurePropagation: "on",
  });
}

describe("createExecutionContext per-invocation override", () => {
  it("applies the override to this child only, override-wins per field", async () => {
    const parent = makeParent();
    const overridden = await parent.createExecutionContext({
      runId: "overridden-run",
      contextOverride: {
        budget: { maxCost: 1 },
        maxCallDepth: 10,
        failurePropagation: "off",
      },
    });

    expect(overridden.getRunId()).toBe("overridden-run");
    // maxCost overridden; parent's maxTimeMs retained (the merge layers budget).
    expect(overridden.budget).toEqual({ maxCost: 1, maxTimeMs: 60_000 });
    expect(overridden.maxCallDepth).toBe(10);
    expect(overridden.failurePropagation).toBe("off");
  });

  it("leaves a child without an override at the frozen parent values", async () => {
    const parent = makeParent();
    const base = await parent.createExecutionContext({ runId: "base-run" });

    expect(base.getRunId()).toBe("base-run");
    expect(base.budget).toEqual({ maxCost: 5, maxTimeMs: 60_000 });
    expect(base.maxCallDepth).toBe(100);
    expect(base.failurePropagation).toBe("on");
  });

  it("does not mutate the parent when a child overrides", async () => {
    const parent = makeParent();
    await parent.createExecutionContext({
      runId: "overridden-run",
      contextOverride: { budget: { maxCost: 1 }, maxCallDepth: 10 },
    });

    expect(parent.budget).toEqual({ maxCost: 5, maxTimeMs: 60_000 });
    expect(parent.maxCallDepth).toBe(100);
  });

  // A subprocess spawned by this run inherits its telemetry sink via
  // getStatelogSink() → withParentStatelog. So the effective per-invocation sink
  // (host/apiKey/projectId) must be visible there, not the frozen parent's.
  it("exposes the per-invocation remote sink through getStatelogSink", async () => {
    const parent = makeParent();
    const execCtx = await parent.createExecutionContext({
      runId: "run",
      contextOverride: {
        observability: true,
        log: { host: "https://call", apiKey: "call-key", projectId: "call-proj" },
      },
    });

    expect(execCtx.getStatelogSink()).toEqual({
      observability: true,
      host: "https://call",
      apiKey: "call-key",
      projectId: "call-proj",
    });
  });

  // An explicit empty apiKey disables the remote POST; it must survive into the
  // sink so a subprocess does not fall back to its baked non-empty credential.
  it("preserves an empty-string apiKey override through getStatelogSink", async () => {
    const parent = makeParent();
    const execCtx = await parent.createExecutionContext({
      runId: "run",
      contextOverride: { observability: true, log: { apiKey: "" } },
    });

    const sink = execCtx.getStatelogSink();
    expect(sink.apiKey).toBe("");
    // the frozen base credential must NOT leak through
    expect(sink.apiKey).not.toBe("base-key");
  });
});

// A program that starts a run may name the file its events go to. That
// arrives as `logFile` on the resolved invocation, beside the host and the
// policy, and never through `contextOverride`, which may come from a request.
describe("createExecutionContext log file", () => {
  function parentThatLogs(logFile?: string) {
    return new RuntimeContext({
      statelogConfig: {
        host: "",
        apiKey: "",
        projectId: "p",
        debugMode: false,
        observability: true,
        ...(logFile === undefined ? {} : { logFile }),
      },
      smoltalkDefaults: {},
      dirname: "/project",
    });
  }

  function linesIn(file: string): string[] {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n") : [];
  }

  it("writes this run's events to the file the invocation names, not the config's", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invocation-log-"));
    try {
      const fromConfig = path.join(dir, "config.jsonl");
      const fromProgram = path.join(dir, "home", "program.jsonl");
      const execCtx = await parentThatLogs(fromConfig).createExecutionContext({
        runId: "run",
        logFile: fromProgram,
      });

      await execCtx.statelogClient.debug("hello", {});

      expect(linesIn(fromProgram)).toHaveLength(1);
      expect(linesIn(fromConfig)).toEqual([]);
      // A subprocess of this run inherits the same file.
      expect(execCtx.getStatelogSink().logFile).toBe(fromProgram);
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), dir);
    }
  });

  it("puts a relative name under the folder of the run's host, where the run reads it back", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "invocation-log-")));
    try {
      const host = nodeHost({ cwd: dir });
      const execCtx = await parentThatLogs().createExecutionContext({
        runId: "run",
        host,
        logFile: "log.jsonl",
      });

      await execCtx.statelogClient.debug("hello", {});

      const written = path.join(dir, "log.jsonl");
      expect(linesIn(written)).toHaveLength(1);
      expect(execCtx.getStatelogSink().logFile).toBe(written);
      expect(await host.files.realPath("log.jsonl")).toBe(written);
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), dir);
    }
  });

  it("reads a leading ~ as the home directory of the run's host", async () => {
    const host = nodeHost();
    const execCtx = await makeParent().createExecutionContext({
      runId: "run",
      host,
      logFile: "~/.myapp/log.jsonl",
    });

    expect(execCtx.getStatelogSink().logFile).toBe(
      path.join(host.system.homeDir(), ".myapp", "log.jsonl"),
    );
  });

  it("gives a run that names no file the config's file, and another run its own", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invocation-log-"));
    try {
      const fromConfig = path.join(dir, "config.jsonl");
      const parent = parentThatLogs(fromConfig);
      const plain = await parent.createExecutionContext({ runId: "plain" });
      const named = await parent.createExecutionContext({
        runId: "named",
        logFile: path.join(dir, "named.jsonl"),
      });

      expect(plain.getStatelogSink().logFile).toBe(fromConfig);
      expect(named.getStatelogSink().logFile).toBe(path.join(dir, "named.jsonl"));
      expect(parent.getStatelogSink().logFile).toBe(fromConfig);
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), dir);
    }
  });

  it("writes nothing when observability is off, whatever file is named", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invocation-log-"));
    try {
      const file = path.join(dir, "quiet.jsonl");
      const execCtx = await makeParent().createExecutionContext({ runId: "run", logFile: file });

      await execCtx.statelogClient.debug("hello", {});

      expect(fs.existsSync(file)).toBe(false);
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), dir);
    }
  });
});
