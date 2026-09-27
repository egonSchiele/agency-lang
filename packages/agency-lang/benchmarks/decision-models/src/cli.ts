import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { cpus, hostname, platform, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { z } from "zod";
import { makeAdapter, makeTextPrompt, type BackendOptions } from "./adapters.js";
import { checkDistribution, parseCases, selectCases } from "./data.js";
import { summarize } from "./metrics.js";
import { runBenchmark, type RecordEntry } from "./runner.js";

export const HELP = `Decision benchmark (no requests are made by --dry-run)

Run:
  pnpm benchmark:decisions --data cases.jsonl --backend jev --out jev.jsonl
  pnpm benchmark:decisions --data cases.jsonl --backend laya --out laya.jsonl
  pnpm benchmark:decisions --data cases.jsonl --backend logprobs --model gpt-4o-mini --out text.jsonl

Options:
  --data PATH         JSONL cases: id, state, questions, gold
  --backend NAME      jev, laya, or logprobs
  --model NAME        Defaults: jev-latest, laya, gpt-4o-mini
  --base-url URL      Defaults: TypeSafe, localhost:8000, OpenAI /v1
  --out PATH          New JSONL results file (existing files are refused)
  --mode NAME         latency (default) or throughput
  --concurrency N     Concurrent cases: 1 in latency mode, 4 in throughput
  --batch-size N      Questions per decision request, 1–64; default 1
                     Logprobs always sends one question per request
  --limit N           Number of sampled cases, default 50
  --seed N            Reproducible sample, default 42
  --repeats N         Measured trials per case, default 1
  --warmup N          Untimed cases before measurement, default 1
  --timeout-ms N      Timeout per provider call, default 30000
  --machine LABEL     Hardware/run label (record Laya server hardware here)
  --dry-run           Validate and preview, without keys or provider calls
  --summary PATH      Recompute metrics from a saved results JSONL
  --help              Show this help

Keys: TYPESAFE_API_KEY for Jev; OPENAI_API_KEY for logprobs.
Laya defaults to a dummy key; override with LAYA_API_KEY if needed.
For OpenRouter Jev use --model jev-1.13 --base-url https://openrouter.ai/api
and put your OpenRouter key in TYPESAFE_API_KEY.
`;

function integer(value: string | undefined, fallback: number, name: string, minimum = 1): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return number;
}

function readRegularFile(path: string): string {
  if (!lstatSync(path).isFile()) {
    throw new Error(`Expected a regular file, not a directory or symlink: ${path}`);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const predictionSchema = z.object({
  label: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).nullable(),
  score: z.number().finite().optional(),
  confidence: z.number().optional(),
  labelMass: z.number().optional(),
  missingLabels: z.array(z.string()).optional(),
});
const savedRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), metadata: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("finished"), elapsedMs: z.number().nonnegative() }),
  z.object({
    kind: z.literal("warmup"),
    index: z.number().int(),
    elapsedMs: z.number().nonnegative(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal("result"),
    caseId: z.string(),
    trial: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    error: z.string().optional(),
    answer: z.object({
      predictions: z.record(z.string(), predictionSchema),
      requests: z.number().int().nonnegative(),
      calls: z.array(z.unknown()).optional(),
    }),
    observations: z.array(
      z.object({
        task: z.string(),
        type: z.enum(["noul", "choice", "score"]),
        labels: z.array(z.string()).min(2),
        gold: z.object({
          label: z.string(),
          score: z.number().optional(),
          probabilities: z.record(z.string(), z.number()).optional(),
        }),
        prediction: predictionSchema.nullable(),
      }),
    ),
  }),
]);

export function readRecords(text: string): RecordEntry[] {
  const records = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        const record = savedRecordSchema.parse(JSON.parse(line));
        if (record.kind === "result") {
          for (const observation of record.observations) {
            const { labels, gold, prediction, type } = observation;
            if (labels.some((label, i) => labels.indexOf(label) !== i)) {
              throw new Error("Saved labels must be distinct.");
            }
            for (const value of [gold, prediction]) {
              if (!value) continue;
              if (!labels.includes(value.label)) {
                throw new Error("Saved answer has an unknown label.");
              }
              if (value.probabilities) checkDistribution(value.probabilities, labels);
              if (
                value.score !== undefined &&
                (!Number.isFinite(value.score) ||
                  value.score < 0 ||
                  value.score > labels.length - 1)
              ) {
                throw new Error("Saved score is outside the label range.");
              }
            }
            if (type === "score" && gold.score === undefined) {
              throw new Error("Saved score question needs a gold score.");
            }
          }
        }
        return record;
      } catch (error) {
        throw new Error(
          `Result line ${index + 1}: ${error instanceof Error ? error.message : error}`,
        );
      }
    });
  if (
    records.filter((record) => record.kind === "run").length !== 1 ||
    records[0]?.kind !== "run"
  ) {
    throw new Error("Expected one run header. Summarize each run file separately.");
  }
  if (records.some((record, index) => record.kind === "finished" && index !== records.length - 1)) {
    throw new Error("The completion marker must be the last record.");
  }
  return records;
}

const stringOption = { type: "string" } as const;
export async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      data: stringOption,
      backend: stringOption,
      model: stringOption,
      out: stringOption,
      "base-url": stringOption,
      mode: stringOption,
      concurrency: stringOption,
      "batch-size": stringOption,
      limit: stringOption,
      seed: stringOption,
      repeats: stringOption,
      warmup: stringOption,
      "timeout-ms": stringOption,
      machine: stringOption,
      summary: stringOption,
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.summary) {
    const records = readRecords(readRegularFile(values.summary));
    console.log(JSON.stringify({ run: records[0], summary: summarize(records) }, null, 2));
    return;
  }
  if (!values.data || !values.backend) {
    throw new Error("--data and --backend are required. See --help.");
  }
  const backend = z.enum(["jev", "laya", "logprobs"]).parse(values.backend);
  const defaults = {
    jev: {
      model: "jev-latest",
      baseUrl: process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai",
    },
    laya: { model: "laya", baseUrl: process.env.LAYA_BASE_URL ?? "http://localhost:8000" },
    logprobs: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
  }[backend];
  const mode = z.enum(["latency", "throughput"]).parse(values.mode ?? "latency");
  const options: BackendOptions = {
    backend,
    model: values.model ?? defaults.model,
    baseUrl: values["base-url"] ?? defaults.baseUrl,
    batchSize: integer(values["batch-size"], 1, "batch-size"),
    timeoutMs: integer(values["timeout-ms"], 30000, "timeout-ms"),
  };
  const endpoint = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Use an HTTP(S) base URL without credentials, query, or fragment.");
  }
  const run = {
    concurrency: integer(values.concurrency, mode === "latency" ? 1 : 4, "concurrency"),
    repeats: integer(values.repeats, 1, "repeats"),
    warmup: integer(values.warmup, 1, "warmup", 0),
  };
  if (
    options.batchSize > 64 ||
    (mode === "latency" && (run.concurrency !== 1 || options.batchSize !== 1)) ||
    (backend === "logprobs" && options.batchSize !== 1)
  ) {
    throw new Error(
      "Latency mode requires concurrency=1 and batch-size=1. Decision throughput batches allow 1–64 questions; logprobs requires batch-size=1.",
    );
  }
  const source = readRegularFile(values.data);
  const seed = integer(values.seed, 42, "seed", 0);
  const cases = selectCases(parseCases(source), integer(values.limit, 50, "limit"), seed);
  if (backend === "logprobs") {
    cases.forEach((item) =>
      Object.values(item.questions).forEach((question) => makeTextPrompt(item.state, question)),
    );
  }
  const metadata = {
    schemaVersion: 1,
    ...options,
    ...run,
    mode,
    seed,
    datasetSha256: createHash("sha256").update(source).digest("hex"),
    caseIds: cases.map((item) => item.id),
    createdAt: new Date().toISOString(),
    node: process.version,
    machine: values.machine ?? hostname(),
    clientHardware: { platform: platform(), cpu: cpus()[0]?.model, memoryBytes: totalmem() },
  };
  if (values["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          ...metadata,
          cases: cases.length,
          decisionsPerTrial: cases.reduce((n, item) => n + Object.keys(item.questions).length, 0),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!values.out) {
    throw new Error("--out is required. Use a new result filename for each run.");
  }
  if (
    (backend === "jev" && !process.env.TYPESAFE_API_KEY) ||
    (backend === "logprobs" && !process.env.OPENAI_API_KEY)
  ) {
    throw new Error(backend === "jev" ? "Set TYPESAFE_API_KEY." : "Set OPENAI_API_KEY.");
  }
  const fd = openSync(values.out, "wx", 0o600);
  const records: RecordEntry[] = [];
  const save = (record: RecordEntry) => {
    appendFileSync(fd, JSON.stringify(record) + "\n");
    records.push(record);
    if (record.kind === "result") {
      console.error(
        `${records.filter((entry) => entry.kind === "result").length}/${cases.length * run.repeats} ${record.caseId}: ${record.error ?? "ok"}`,
      );
    }
  };
  try {
    save({ kind: "run", metadata });
    await runBenchmark(cases, makeAdapter(options), run, save);
  } finally {
    closeSync(fd);
  }
  console.log(JSON.stringify(summarize(records), null, 2));
}

/** Convert UCI's tab-separated SMS file without changing its labels. */
export function importSms(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        const tab = line.indexOf("\t");
        const label = line.slice(0, tab);
        if (tab < 0 || !["ham", "spam"].includes(label)) {
          throw new Error(`SMS line ${index + 1}: expected ham or spam followed by a tab.`);
        }
        return JSON.stringify({
          id: `sms-${index + 1}`,
          state: line.slice(tab + 1),
          questions: { spam: { type: "noul", instructions: "Is this message unsolicited spam?" } },
          gold: { spam: { label: label === "spam" ? "true" : "false" } },
        });
      })
      .join("\n") + "\n"
  );
}

export function convertSms(input: string, output: string): void {
  const converted = importSms(readRegularFile(input));
  parseCases(converted);
  writeFileSync(output, converted, { flag: "wx", mode: 0o600 });
}
