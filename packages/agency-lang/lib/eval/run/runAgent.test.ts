import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalTarget } from "@/agentTarget.js";
import { finishedTraceLines } from "@/runDirectory/testFixtures.js";

import { runAgent } from "./runAgent.js";
import type { EvalRunnerJob } from "./subprocess.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runagent-"));
  dirs.push(tempDir);
  return tempDir;
}

function makeAgentProject(): { agentPath: string; baseDir: string } {
  const baseDir = tmp();
  fs.mkdirSync(path.join(baseDir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, "lib", "helper.agency"),
    'export def helper(): string { return "hi" }\n',
  );
  fs.writeFileSync(
    path.join(baseDir, "agent.agency"),
    'import { helper } from "./lib/helper.agency"\nnode main() {}\n',
  );
  return { agentPath: path.join(baseDir, "agent.agency"), baseDir };
}

/** File target for a test agent — the label is never load-bearing here. */
function fileTarget(agentPath: string): EvalTarget {
  return { kind: "file", agentFile: agentPath, node: "main", label: `${agentPath}:main` };
}

/** A fake runner that behaves like a real child: writes a finished trace under
 *  the trace id the harness handed it, with `output` as the return value. */
function traceWritingRunner(output: unknown, observe?: (job: EvalRunnerJob) => void) {
  return async (job: EvalRunnerJob) => {
    observe?.(job);
    fs.writeFileSync(
      job.statelogPath,
      finishedTraceLines(job.traceId, { output }).join("\n") + "\n",
    );
    return { ok: true as const };
  };
}

describe("runAgent", () => {
  it("runs the recipe: seeds, compiles, executes with cwd=workdir, reads the trace, returns the output", async () => {
    const { agentPath } = makeAgentProject();
    const runDir = path.join(tmp(), "run-1");
    let observed: EvalRunnerJob | undefined;

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      { runDir, traceId: "trace-1", config: {} },
      { runner: traceWritingRunner("New Delhi", (job) => (observed = job)) },
    );

    expect(run.status).toBe("success");
    if (run.status === "success") {
      expect(run.output).toBe("New Delhi");
      expect(run.workdir).toBe(path.join(runDir, "workdir"));
      expect(run.statelogPath).toBe(path.join(runDir, "agent", "statelog.jsonl"));
      expect(run.seededAgentEntry).toBe(path.join(runDir, "workdir", "agent.agency"));
    }
    expect(observed?.cwd).toBe(path.join(runDir, "workdir"));
    // The harness-minted trace id and the seeded code's identity reach the child.
    expect(observed?.traceId).toBe("trace-1");
    expect(observed?.kind === "file" && observed.code.entry).toBe("agent.agency");
  });

  it("seedFiles land in the workdir; a failed run lists what was seeded and leaves no statelog", async () => {
    const { agentPath } = makeAgentProject();
    const seedFiles = tmp();
    fs.writeFileSync(path.join(seedFiles, "hint.txt"), "Paris");
    const runDir = path.join(tmp(), "run-2");

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      { runDir, traceId: "trace-2", config: {}, seedFiles },
      {
        runner: async () => ({ ok: false, errorMessage: "boom" }),
      },
    );

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/^boom\n\nWorkdir was seeded with/);
      expect(run.statelogPath).toBeNull();
    }
    expect(fs.existsSync(path.join(runDir, "workdir", "hint.txt"))).toBe(true);
  });

  it("a seeding failure (collision) is an error result, not a throw", async () => {
    const { agentPath } = makeAgentProject();
    const seedFiles = tmp();
    fs.writeFileSync(path.join(seedFiles, "agent.agency"), "node main() {}\n");

    const run = await runAgent(fileTarget(agentPath), "t", {
      runDir: path.join(tmp(), "run-3"),
      traceId: "trace-3",
      config: {},
      seedFiles,
    });

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/Seed collision/);
    }
  });

  it("a clean exit that left no statelog is an error — a completed run always records one", async () => {
    const run4Dir = path.join(tmp(), "run-4");
    const { agentPath } = makeAgentProject();

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      { runDir: run4Dir, traceId: "trace-4", config: {} },
      {
        runner: async () => ({ ok: true }),
      },
    );

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/wrote no statelog/);
      expect(run.statelogPath).toBeNull();
    }
  });

  it("a failed run that wrote a statelog keeps it — the trace is the evidence", async () => {
    const run7Dir = path.join(tmp(), "run-7");
    const { agentPath } = makeAgentProject();

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      { runDir: run7Dir, traceId: "trace-7", config: {} },
      {
        runner: async (job: EvalRunnerJob) => {
          fs.writeFileSync(
            job.statelogPath,
            finishedTraceLines(job.traceId, { output: "partial" }).join("\n") + "\n",
          );
          return { ok: false, errorMessage: "died late" };
        },
      },
    );

    expect(run.status).toBe("error");
    expect(run.statelogPath).toBe(path.join(run7Dir, "agent", "statelog.jsonl"));
  });

  it("command targets: seeds only the test files, compiles nothing, and hands the runner the substituted argv", async () => {
    const runDir = path.join(tmp(), "run-cmd");
    const filesDir = tmp();
    fs.writeFileSync(path.join(filesDir, "data.txt"), "fixture");
    const target = {
      kind: "command" as const,
      tokens: ["node", "run.js", "-p", "{task}"],
      label: "node run.js -p {task}",
    };
    let job: unknown;

    const run = await runAgent(
      target,
      "do the thing",
      { runDir, traceId: "trace-cmd", config: {}, seedFiles: filesDir },
      { runner: traceWritingRunner("done", (j) => (job = j)) },
    );

    expect(run.status).toBe("success");
    expect(job).toMatchObject({
      kind: "command",
      argv: ["node", "run.js", "-p", "do the thing"],
      cwd: path.join(runDir, "workdir"),
      traceId: "trace-cmd",
    });
    expect(fs.readFileSync(path.join(runDir, "workdir", "data.txt"), "utf8")).toBe("fixture");
    // nothing compiled: only the fixture landed in the workdir
    expect(
      fs
        .readdirSync(path.join(runDir, "workdir"))
        .filter((f) => f.endsWith(".js") || f.endsWith(".agency")),
    ).toEqual([]);
  });

  it("command targets: a missing statelog error names the --log clobber cause", async () => {
    const target = { kind: "command" as const, tokens: ["x", "{task}"], label: "x {task}" };
    const run = await runAgent(
      target,
      "t",
      {
        runDir: path.join(tmp(), "run-cmd-nolog"),
        traceId: "trace-nolog",
        config: {},
      },
      {
        runner: async () => ({ ok: true }), // "succeeds" but writes no statelog
      },
    );

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/If your command passes --log, remove it/);
    }
  });

  it("command targets: an oversized substituted task is an error result naming the size", async () => {
    const target = {
      kind: "command" as const,
      tokens: ["node", "-e", "{task}"],
      label: "node -e {task}",
    };
    const run = await runAgent(target, "x".repeat(128 * 1024 + 1), {
      runDir: path.join(tmp(), "run-cmd-big"),
      traceId: "trace-big",
      config: {},
    }); // real runner: the size check fires before any spawn

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/over the .*-byte cap/);
    }
  });
});
