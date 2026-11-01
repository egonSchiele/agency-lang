import * as fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { event } from "@/logsViewer/storyFixture.js";

import { HEADER_CHARS, logsOutline } from "./outline.js";
import { queryDeps, queryDir, writeLog } from "./queryFixture.js";

const flags = { json: false, approvals: false, admin: false };

describe("logsOutline", () => {
  let dir: string;
  beforeEach(() => {
    dir = queryDir();
    writeLog(dir, "log.jsonl", [
      { traceId: "older-run", minutesAgo: 60 },
      { traceId: "newest-run", minutesAgo: 1, error: true },
    ]);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints the newest trace by default, under lines naming the log and the trace", async () => {
    const result = await logsOutline({ ...flags, log: "log.jsonl" }, queryDeps(dir));
    const lines = result.text.split("\n");
    expect(result.exitCode).toBe(0);
    expect(lines[0]).toBe("log.jsonl · outline of 1 trace · 2 traces in the log");
    expect(lines[2]).toMatch(/^newest-run · .* · 3 LLM calls · .* · error$/);
    expect(lines[4]).toMatch(/^newest-run\/round:L:0:user +User turn · write a module$/);
    expect(result.text).not.toContain("older-run");
    // The approved read in loopEvents is hidden; the rejected grep shows.
    expect(result.text).not.toContain("std::read · approved");
    expect(result.text).toContain("Interrupt · std::grep · rejected · Search?");
  });

  it("--approvals shows the approved interrupt", async () => {
    const result = await logsOutline(
      { ...flags, log: "log.jsonl", approvals: true },
      queryDeps(dir),
    );
    expect(result.text).toContain("std::read · approved");
  });

  it("--last 2 prints both traces, newest first", async () => {
    const result = await logsOutline({ ...flags, log: "log.jsonl", last: 2 }, queryDeps(dir));
    expect(result.text.indexOf("newest-run ·")).toBeLessThan(result.text.indexOf("older-run ·"));
  });

  it("cuts a long header to HEADER_CHARS", async () => {
    const paragraph = "word ".repeat(400);
    writeLog(dir, "long.jsonl", [
      {
        traceId: "long",
        minutesAgo: 1,
        events: [
          event("promptCompletion", 100, "L", null, {
            messages: [{ role: "user", content: paragraph }],
            completion: { output: "ok" },
          }),
        ],
      },
    ]);
    const result = await logsOutline({ ...flags, log: "long.jsonl" }, queryDeps(dir));
    const userLine = result.text.split("\n").find((line) => line.includes("User turn"))!;
    const header = userLine.slice(userLine.indexOf("User turn"));
    expect(header.length).toBeLessThanOrEqual(HEADER_CHARS);
    expect(header.endsWith("…")).toBe(true);
  });

  it("--json gives the log path and, per trace, its summary and rows", async () => {
    const result = await logsOutline({ ...flags, json: true, log: "log.jsonl" }, queryDeps(dir));
    const json = result.json as { log: string; traces: { traceId: string; rows: unknown[] }[] };
    expect(json.log).toBe(`${dir}/log.jsonl`);
    expect(json.traces.map((trace) => trace.traceId)).toEqual(["newest-run"]);
    expect(json.traces[0].rows[0]).toEqual({
      address: "newest-run/round:L:0:user",
      rowId: "round:L:0:user",
      kind: "user",
      depth: 0,
      header: "User turn · write a module",
    });
  });
});
