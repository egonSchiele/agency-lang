import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { convertSms, importSms, main, readRecords } from "./cli.js";
import { parseCases } from "./data.js";

const directory = mkdtempSync(join(tmpdir(), "decision-bench-test-"));
afterEach(() => vi.restoreAllMocks());

it("imports SMS labels and preserves tabs in the message", () => {
  const cases = parseCases(importSms("ham\tHello\tthere\nspam\tWin money!\n"));
  expect(cases[0].state).toBe("Hello\tthere");
  expect(cases.map((row) => row.gold.spam.label)).toEqual(["false", "true"]);
  expect(() => importSms("invalid row")).toThrow(/line 1/i);
});

it("preserves bracket-prefixed text that is not a JSON document", () => {
  const cases = parseCases(importSms("ham\t[Urgent] Call me\nspam\t{Offer} Win money!\n"));
  expect(cases.map((item) => item.state)).toEqual(["[Urgent] Call me", "{Offer} Win money!"]);
});

it("validates a run without requiring keys or contacting a provider", async () => {
  const file = join(directory, "cases.jsonl");
  writeFileSync(file, importSms("ham\tHi!\nspam\tWin!\n"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await main(["--data", file, "--backend", "logprobs", "--dry-run"]);
  expect(JSON.parse(log.mock.calls[0][0]).decisionsPerTrial).toBe(2);
  await expect(
    main([
      "--data",
      file,
      "--backend",
      "laya",
      "--mode",
      "latency",
      "--concurrency",
      "2",
      "--dry-run",
    ]),
  ).rejects.toThrow(/Latency/);
});

it("refuses to overwrite an imported file", () => {
  const input = join(directory, "sms.txt");
  const output = join(directory, "import.jsonl");
  writeFileSync(input, "ham\thello\n");
  convertSms(input, output);
  const content = readFileSync(output, "utf8");
  expect(() => convertSms(input, output)).toThrow();
  expect(readFileSync(output, "utf8")).toBe(content);
});

it("records a supplied Laya checkpoint hash and preserves it in offline summaries", async () => {
  const file = join(directory, "checkpoint-cases.jsonl");
  writeFileSync(file, importSms("ham\tHello!\n"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const hash = "AB".repeat(32);
  await main(["--data", file, "--backend", "laya", "--checkpoint-sha256", hash, "--dry-run"]);
  const metadata = JSON.parse(log.mock.calls[0][0]);
  expect(metadata.checkpointSha256).toBe(hash.toLowerCase());
  const saved = join(directory, "checkpoint-run.jsonl");
  writeFileSync(saved, JSON.stringify({ kind: "run", metadata }) + "\n");
  await main(["--summary", saved]);
  expect(JSON.parse(log.mock.calls[1][0]).run.metadata.checkpointSha256).toBe(hash.toLowerCase());
});

it.each(["", "abc", "z".repeat(64), "a".repeat(63), "a".repeat(65)])(
  "rejects malformed checkpoint hash %j before running",
  async (hash) => {
    await expect(
      main([
        "--data",
        "not-read.jsonl",
        "--backend",
        "laya",
        "--checkpoint-sha256",
        hash,
        "--dry-run",
      ]),
    ).rejects.toThrow(/checkpoint-sha256.*64.*hexadecimal/);
  },
);

it("rejects concatenated runs and malformed saved records", () => {
  expect(() => readRecords('{"kind":"run","metadata":{}}\n{"kind":"run","metadata":{}}')).toThrow(
    /one run header/,
  );
  expect(() => readRecords('{"kind":"result"}')).toThrow(/line 1/i);
});

it("rejects incomplete saved distributions before computing metrics", () => {
  const records = [
    { kind: "run", metadata: {} },
    {
      kind: "result",
      caseId: "one",
      trial: 0,
      elapsedMs: 1,
      answer: { predictions: {}, requests: 1 },
      observations: [
        {
          task: "spam",
          type: "noul",
          labels: ["false", "true"],
          gold: { label: "false" },
          prediction: { label: "false", probabilities: { false: 1 } },
        },
      ],
    },
  ];
  expect(() => readRecords(records.map((record) => JSON.stringify(record)).join("\n"))).toThrow(
    /probabilities/i,
  );
});

it("rejects records after the completion marker", () => {
  expect(() =>
    readRecords(
      [
        { kind: "run", metadata: {} },
        { kind: "finished", elapsedMs: 1 },
        { kind: "warmup", index: 0, elapsedMs: 1 },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    ),
  ).toThrow(/last/);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));
