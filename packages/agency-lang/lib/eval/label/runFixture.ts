import * as fs from "fs";
import * as path from "path";

/** One input in a fake eval run. Every field has a default, so a test names
 *  only what it is actually about. */
export type FixtureInput = {
  inputId: string;
  status?: "success" | "error";
  task?: unknown;
  traceId?: string;
  outputs?: unknown[];
  omitRecord?: boolean;
  legacyShape?: boolean;
};

export type WriteRunFixtureArgs = {
  dir: string;
  inputs: readonly FixtureInput[];
};

/**
 * Write a directory shaped like the output of `agency eval run`.
 *
 * Shared because two test files were each building their own copy of this
 * layout. The layout belongs to `readEvalRun`, not to either test, so a second
 * copy is a second thing to update when the real one changes — and the copy
 * that gets missed keeps passing against a shape that no longer exists.
 */
export function writeRunFixture(args: WriteRunFixtureArgs): string {
  const { dir, inputs } = args;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    provenance: { agent: { kind: "file", entry: "news.agency" } },
  }));
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({
    runId: path.basename(dir),
    runDir: dir,
    agentLabel: "news.agency:main",
    okCount: inputs.length,
    errorCount: 0,
    inputs: inputs.map((input) => ({
      inputId: input.inputId,
      status: input.status ?? "success",
      evalRecordPath: path.join(dir, "inputs", input.inputId, "agent", "eval-record.json"),
      statelogPath: "",
      workdirPath: "",
    })),
  }));

  for (const input of inputs) {
    const inputDir = path.join(dir, "inputs", input.inputId);
    fs.mkdirSync(path.join(inputDir, "agent"), { recursive: true });
    fs.writeFileSync(path.join(inputDir, "input.json"), JSON.stringify({
      id: input.inputId,
      task: input.task === undefined ? "do a thing" : input.task,
    }));
    if (input.omitRecord === true) {
      continue;
    }
    fs.writeFileSync(
      path.join(inputDir, "agent", "eval-record.json"),
      JSON.stringify(recordFor(input)),
    );
  }
  return dir;
}

function recordFor(input: FixtureInput): unknown {
  const traceId = input.traceId ?? "trace-1";
  if (input.legacyShape === true) {
    return { traceId, finalResponse: "legacy" };
  }
  return {
    traceId,
    startedAtMs: 1000,
    durationMs: 5,
    evalOutputs: input.outputs ?? [{ value: "hello", threadId: "0", tMs: 1 }],
    metrics: { models: ["gpt-4o"] },
  };
}
