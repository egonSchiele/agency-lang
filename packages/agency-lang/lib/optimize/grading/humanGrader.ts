import * as readline from "readline/promises";

import { BaseGrader } from "./baseGrader.js";
import type { Grade, GraderInput, GraderOptions } from "./types.js";

export type Scale = { min: number; max: number };
export type HumanReviewRequest = { prompt: string; artifact: string; scale?: Scale };
export type HumanReviewResponse = { rating?: number; pass?: boolean; note?: string };
export type HumanRead = (request: HumanReviewRequest) => Promise<HumanReviewResponse>;

type HumanGraderOptions = GraderOptions & {
  prompt?: string;     // shown above the artifact
  scale?: Scale;       // omit → binary pass/fail
  read?: HumanRead;    // defaults to the terminal reader; inject in tests / web harnesses
};

/** A grader that pauses for a human rating. Configured entirely by constructor settings. */
export class HumanGrader extends BaseGrader {
  protected readonly defaultName = "human";
  // Distinct name so it doesn't shadow BaseGrader.options, whose samples is forced to 1.
  private readonly humanOptions: HumanGraderOptions;
  constructor(options: HumanGraderOptions = {}) {
    super({ ...options, samples: 1 });   // a human is asked exactly once
    this.humanOptions = options;
    const { scale } = options;
    if (scale && !(Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.max > scale.min)) {
      throw new Error(`HumanGrader: scale must have finite min < max, got ${globalThis.JSON.stringify(scale)}`);
    }
  }

  protected async _run({ run }: GraderInput): Promise<Grade> {
    const read = this.humanOptions.read ?? terminalRead;
    const scale = this.humanOptions.scale;
    const response = await read({
      prompt: this.humanOptions.prompt ?? `Review this output (${this.name()}):`,
      artifact: typeof run.output === "string" ? run.output : globalThis.JSON.stringify(run.output),
      scale,
    });
    const note = response.note ? { feedback: response.note } : {};
    if (!scale) {
      if (response.pass === undefined) {
        throw new Error(`HumanGrader (${this.name()}): expected a pass/fail verdict, got none`);
      }
      return { score: { kind: "binary", pass: response.pass }, ...note };
    }
    const rating = response.rating;
    if (rating === undefined || !Number.isFinite(rating) || rating < scale.min || rating > scale.max) {
      throw new Error(`HumanGrader (${this.name()}): expected a rating in [${scale.min}, ${scale.max}], got ${rating}`);
    }
    return { score: { kind: "scalar", value: (rating - scale.min) / (scale.max - scale.min) }, ...note };
  }
}

/** Parse a scalar answer: leading number is the rating, the rest is a note. Non-numeric → note only. */
export function parseScalarAnswer(answer: string): HumanReviewResponse {
  const [head, ...rest] = answer.trim().split(/\s+/).filter(Boolean);
  const rating = Number(head);
  if (head !== undefined && Number.isFinite(rating)) {
    return { rating, note: rest.join(" ") || undefined };
  }
  return { note: answer.trim() || undefined };
}

/** Parse a binary answer: leading y/n is the verdict, the rest is a note. Otherwise → note only. */
export function parseBinaryAnswer(answer: string): HumanReviewResponse {
  const [head, ...rest] = answer.trim().split(/\s+/).filter(Boolean);
  const h = head?.toLowerCase();
  if (h === "y" || h === "yes") return { pass: true, note: rest.join(" ") || undefined };
  if (h === "n" || h === "no") return { pass: false, note: rest.join(" ") || undefined };
  return { note: answer.trim() || undefined };
}

/** Default reader: prompt on the terminal and read one line. Fails fast with no TTY (e.g. CI). */
export const terminalRead: HumanRead = async (request) => {
  if (!process.stdin.isTTY) {
    throw new Error(
      "HumanGrader needs an interactive terminal but stdin is not a TTY (e.g. CI). " +
      "Run interactively or remove the human grader for this run.",
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${request.prompt}\n${request.artifact}\n`);
    if (request.scale) {
      return parseScalarAnswer(await rl.question(`Rating (${request.scale.min}-${request.scale.max}), optional note after a space: `));
    }
    return parseBinaryAnswer(await rl.question("Pass? (y/n), optional note after a space: "));
  } finally {
    rl.close();
  }
};
