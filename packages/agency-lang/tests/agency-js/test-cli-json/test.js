// `agency test --json`: stdout is exactly one parseable document; every
// human line (including the shard line and the summary) is on stderr.
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../../dist/scripts/agency.js");

function agencyTest(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, "test", "run", "--json", ...args], {
      cwd: here,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: stdout.toString(), stderr: "" };
  } catch (e) {
    return { exitCode: e.status ?? 1, stdout: `${e.stdout ?? ""}`, stderr: `${e.stderr ?? ""}` };
  }
}

function summarize(run) {
  const lines = run.stdout.split("\n").filter((l) => l.length > 0);
  let doc = null;
  try {
    doc = lines.length === 1 ? JSON.parse(lines[0]) : null;
  } catch {
    doc = null;
  }
  return { lines, doc };
}

const normal = agencyTest(["one.test.json"]);
const n = summarize(normal);
const failing = n.doc?.files?.[0]?.cases?.find((c) => c.node === "fails");

const sharded = agencyTest(["--shard", "1/2", "one.test.json", "two.test.json"]);
const s = summarize(sharded);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      normal: {
        exitCode: normal.exitCode,
        stdoutLines: n.lines.length,
        version: n.doc?.version ?? null,
        passed: n.doc?.passed ?? null,
        failed: n.doc?.failed ?? null,
        fileStatus: n.doc?.files?.[0]?.status ?? null,
        failingAttempts: failing?.attempts ?? null,
        failingFeedbackHasBoth:
          !!failing?.feedback?.includes("3") && !!failing?.feedback?.includes("2"),
        summaryOnStderr: normal.stderr.includes("tests passed"),
      },
      sharded: {
        stdoutLines: s.lines.length,
        files: s.doc?.files?.length ?? null,
        shardLineOnStderr: sharded.stderr.includes("Shard 1/2"),
        shardLineOnStdout: sharded.stdout.includes("Shard 1/2"),
      },
    },
    null,
    2,
  ),
);
