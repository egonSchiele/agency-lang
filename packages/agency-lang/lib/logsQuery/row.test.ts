import * as fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hostedSearchEvents } from "@/logsViewer/storyFixture.js";
import { FIELD_NAMES } from "@/runDirectory/traceSelection.js";

import { logsOutline } from "./outline.js";
import { queryDeps, queryDir, writeLog } from "./queryFixture.js";
import { logsRow, MIN_ROW_CHARS } from "./row.js";

type Row = { address: string; kind: string };

describe("logsRow", () => {
  let dir: string;
  beforeEach(() => {
    dir = queryDir();
    writeLog(dir, "log.jsonl", [
      { traceId: "run-one", minutesAgo: 10 },
      { traceId: "searched", minutesAgo: 5, events: hostedSearchEvents() },
    ]);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deps = () => queryDeps(dir, { names: FIELD_NAMES });

  async function rowsOf(trace: string): Promise<Row[]> {
    const outline = await logsOutline(
      { log: "log.jsonl", json: true, approvals: false, admin: false, trace },
      deps(),
    );
    return (outline.json as { traces: { rows: Row[] }[] }).traces[0].rows;
  }

  it("opens an address from the outline", async () => {
    const [first] = await rowsOf("run-one");
    const result = await logsRow({ address: first.address, log: "log.jsonl", maxChars: 0 }, deps());
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      address: first.address,
      kind: "user",
      header: "User turn · write a module",
      truncated: false,
    });
    expect(result.text.startsWith(first.address)).toBe(true);
    expect((result.json as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });

  it("refuses a bare row id", async () => {
    const result = await logsRow({ address: "guide", log: "log.jsonl", maxChars: 0 }, deps());
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.text).toContain('"guide" is not a row address: use <trace id>/<row id>');
  });

  it("refuses a row the trace does not have", async () => {
    const result = await logsRow(
      { address: "run-one/nope", log: "log.jsonl", maxChars: 0 },
      deps(),
    );
    expect(result).toMatchObject({ exitCode: 1, text: "no row nope in trace run-one" });
  });

  it("cuts the text to maxChars, marker included, and says so", async () => {
    const rows = await rowsOf("run-one");
    const tool = rows.find((row) => row.kind === "tool")!;
    const whole = await logsRow({ address: tool.address, log: "log.jsonl", maxChars: 0 }, deps());
    expect(whole.text.length).toBeGreaterThan(MIN_ROW_CHARS);
    const cut = await logsRow(
      { address: tool.address, log: "log.jsonl", maxChars: MIN_ROW_CHARS },
      deps(),
    );
    expect(cut.text.length).toBeLessThanOrEqual(MIN_ROW_CHARS);
    expect(cut.text).toMatch(/…\[truncated [\d,]+ chars\]$/);
    expect(cut.json).toMatchObject({ truncated: true });
  });

  it.each([50, 2.5, -1])("refuses maxChars of %d, naming the field", async (maxChars) => {
    const result = await logsRow({ address: "run-one/guide", log: "log.jsonl", maxChars }, deps());
    expect(result).toMatchObject({
      exitCode: 1,
      text: "maxChars is 0 for no cap, or at least 100",
    });
  });

  it("carries a hosted row's provider items, since it has no events", async () => {
    const hosted = (await rowsOf("searched")).find((row) => row.kind === "hosted")!;
    const result = await logsRow(
      { address: hosted.address, log: "log.jsonl", maxChars: 0 },
      deps(),
    );
    const json = result.json as { events: unknown[]; providerItems?: unknown[] };
    expect(json.events).toEqual([]);
    expect(json.providerItems?.length).toBeGreaterThan(0);
  });
});
