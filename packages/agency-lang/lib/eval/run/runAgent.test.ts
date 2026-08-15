import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalTarget } from "@/agentTarget.js";
import type { EvalRunnerJob } from "./subprocess.js";
import { runAgent } from "./runAgent.js";

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

/** Writes the record grading would read, with one output value. */
function recordWritingExtractor(output: unknown) {
  return async ({ outPath }: { outPath: string }) => {
    fs.writeFileSync(
      outPath,
      JSON.stringify({ evalOutputs: [{ value: output, threadId: "0", tMs: 1 }] }),
    );
  };
}

describe("runAgent", () => {
  it("runs the recipe: seeds, compiles, executes with cwd=workdir, extracts, returns the output", async () => {
    const { agentPath } = makeAgentProject();
    const runDir = path.join(tmp(), "run-1");
    let observedCwd = "";

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      {
        runDir,
        config: {},
        extractor: recordWritingExtractor("New Delhi"),
      },
      {
        runner: async (job: EvalRunnerJob) => {
          const { cwd, statelogPath } = job as { cwd: string; statelogPath: string };
          observedCwd = cwd;
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
      },
    );

    expect(run.status).toBe("success");
    if (run.status === "success") {
      expect(run.output).toBe("New Delhi");
      expect(run.workdir).toBe(path.join(runDir, "workdir"));
    }
    expect(observedCwd).toBe(path.join(runDir, "workdir"));
    expect(fs.existsSync(path.join(runDir, "agent", "statelog.jsonl"))).toBe(true);
  });

  it("seedFiles land in the workdir; a failed run lists what was seeded and writes error.txt", async () => {
    const { agentPath } = makeAgentProject();
    const seedFiles = tmp();
    fs.writeFileSync(path.join(seedFiles, "hint.txt"), "Paris");
    const runDir = path.join(tmp(), "run-2");

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      { runDir, config: {}, seedFiles },
      {
        runner: async () => ({ ok: false, errorMessage: "boom" }),
      },
    );

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/^boom\n\nWorkdir was seeded with/);
    }
    expect(fs.readFileSync(path.join(runDir, "agent", "error.txt"), "utf8")).toMatch(/^boom/);
    expect(fs.existsSync(path.join(runDir, "workdir", "hint.txt"))).toBe(true);
  });

  it("a seeding failure (collision) is an error result, not a throw", async () => {
    const { agentPath } = makeAgentProject();
    const seedFiles = tmp();
    fs.writeFileSync(path.join(seedFiles, "agent.agency"), "node main() {}\n");

    const run = await runAgent(fileTarget(agentPath), "t", {
      runDir: path.join(tmp(), "run-3"),
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
      { runDir: run4Dir, config: {} },
      {
        runner: async () => ({ ok: true }),
      },
    );

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/produced no eval record/);
    }
    expect(fs.existsSync(path.join(run4Dir, "agent", "error.txt"))).toBe(true);
  });

  it("an extractor crash is an error carrying the extractor's message, not 'no statelog'", async () => {
    const { agentPath } = makeAgentProject();

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      {
        runDir: path.join(tmp(), "run-5"),
        config: {},
        extractor: async () => {
          throw new Error("extractor exploded");
        },
      },
      {
        runner: async (job: EvalRunnerJob) => {
          const { statelogPath } = job as { statelogPath: string };
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
      },
    );

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/extractor exploded/);
    }
  });

  it("an extractor that runs but writes no record file is an error too", async () => {
    const { agentPath } = makeAgentProject();

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      {
        runDir: path.join(tmp(), "run-6"),
        config: {},
        extractor: async () => {},
      },
      {
        runner: async (job: EvalRunnerJob) => {
          const { statelogPath } = job as { statelogPath: string };
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
      },
    );

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/produced no eval record/);
    }
  });

  it("a failed run still salvages its record to disk, so a crash after useful work keeps its evidence", async () => {
    const run7Dir = path.join(tmp(), "run-7");
    const { agentPath } = makeAgentProject();

    const run = await runAgent(
      fileTarget(agentPath),
      "t",
      {
        runDir: run7Dir,
        config: {},
        extractor: recordWritingExtractor("partial work"),
      },
      {
        runner: async (job: EvalRunnerJob) => {
          const { statelogPath } = job as { statelogPath: string };
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: false, errorMessage: "died late" };
        },
      },
    );

    expect(run.status).toBe("error");
    const salvaged = JSON.parse(
      fs.readFileSync(path.join(run7Dir, "agent", "eval-record.json"), "utf8"),
    );
    expect(salvaged.evalOutputs[0].value).toBe("partial work");
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
      {
        runDir,
        config: {},
        seedFiles: filesDir,
        extractor: recordWritingExtractor("done"),
      },
      {
        runner: async (j: EvalRunnerJob) => {
          job = j;
          fs.writeFileSync((j as { statelogPath: string }).statelogPath, "{}\n");
          return { ok: true };
        },
      },
    );

    expect(run.status).toBe("success");
    expect(job).toMatchObject({
      kind: "command",
      argv: ["node", "run.js", "-p", "do the thing"],
      cwd: path.join(runDir, "workdir"),
    });
    expect((job as { traceId: string }).traceId).toBeTruthy();
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
      config: {},
    }); // real runner: the size check fires before any spawn

    expect(run.status).toBe("error");
    if (run.status === "error") {
      expect(run.errorMessage).toMatch(/over the .*-byte cap/);
    }
  });
});
