import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readRecords } from "./cli.js";
import { parseCases, selectCases } from "./data.js";
import { summarize } from "./metrics.js";

function read(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

it("preserves the published source and converted dataset checksums", () => {
  const source = JSON.parse(read("data/sms/source.json"));
  for (const [file, checksum] of Object.entries(source.sha256)) {
    expect(
      createHash("sha256")
        .update(read(`data/sms/${file}`))
        .digest("hex"),
    ).toBe(checksum);
  }
});

it("links the fine-tuned run to its verified checkpoint without claiming capture at run time", () => {
  const header = readRecords(read("results/sms/laya-finetuned-sms.jsonl"))[0];
  if (header.kind !== "run") throw new Error("Missing run header");
  const verification = JSON.parse(read("results/sms/finetune/checkpoint-verification.json"));
  expect(header.metadata.checkpointSha256).toBe(verification.checkpointSha256);
  expect(header.metadata.checkpointSha256Source).toContain("retrospectively");
});

it.each([
  ["jev-openrouter-sms", 1447],
  ["laya-english-sms", 1293],
  ["laya-finetuned-sms", 1413],
  ["logprobs-sms", 1368],
])("recomputes the archived %s result on the fixed sample", (file, correct) => {
  const data = read("data/sms/sms-unique.jsonl");
  const cases = selectCases(parseCases(data), 500, 42);
  const records = readRecords(read(`results/sms/${file}.jsonl`));
  const header = records.find((record) => record.kind === "run")!;
  expect(header.metadata.datasetSha256).toBe(createHash("sha256").update(data).digest("hex"));
  expect(header.metadata.caseIds).toEqual(cases.map((item) => item.id));
  const results = records.filter((record) => record.kind === "result");
  for (const item of cases) {
    const matches = results.filter((record) => record.caseId === item.id);
    expect(matches.map((record) => record.trial).sort()).toEqual([0, 1, 2]);
    for (const match of matches) expect(match.observations[0].gold).toEqual(item.gold.spam);
  }
  const report = summarize(records);
  expect(report.cases).toBe(1500);
  expect(report.errors).toBe(0);
  expect(report.completedDecisions).toBe(1500);
  expect(Object.values(report.tasks)[0].accuracy).toBe(Number(correct) / 1500);
});
