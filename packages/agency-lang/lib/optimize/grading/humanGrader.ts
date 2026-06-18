import * as readline from "readline/promises";

import { BaseGrader } from "./baseGrader.js";
import type { Grade, GraderInput, GraderOptions } from "./types.js";

export type HumanReviewRequest = { prompt: string; artifact: string; scale?: { min: number; max: number } };
export type HumanReviewResponse = { rating?: number; pass?: boolean; note?: string };
export type HumanRead = (request: HumanReviewRequest) => Promise<HumanReviewResponse>;

type HumanGraderOptions = GraderOptions & {
  prompt?: string;                       // shown above the artifact
  scale?: { min: number; max: number };  // omit → binary pass/fail
  read?: HumanRead;                       // defaults to the terminal reader; inject in tests / web harnesses
};

/** A grader that pauses for a human rating. Configured entirely by constructor settings. */
export class HumanGrader extends BaseGrader {
  protected readonly defaultName = "human";
  // Stored under a distinct name so it does not shadow BaseGrader.options, whose
  // samples is forced to 1 below (a human is asked exactly once).
  private readonly humanOptions: HumanGraderOptions;
  constructor(options: HumanGraderOptions = {}) {
    super({ ...options, samples: 1 });
    this.humanOptions = options;
  }

  protected async _run({ run }: GraderInput): Promise<Grade> {
    const read = this.humanOptions.read ?? terminalRead;
    const scale = this.humanOptions.scale;
    const response = await read({
      prompt: this.humanOptions.prompt ?? `Review this output (${this.name()}):`,
      artifact: typeof run.output === "string" ? run.output : globalThis.JSON.stringify(run.output),
      scale,
    });
    if (!scale) {
      return { score: { kind: "binary", pass: response.pass ?? false }, ...(response.note ? { feedback: response.note } : {}) };
    }
    const span = (scale.max - scale.min) || 1;
    const value = ((response.rating ?? scale.min) - scale.min) / span;
    return { score: { kind: "scalar", value }, ...(response.note ? { feedback: response.note } : {}) };
  }
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
      const answer = await rl.question(`Rating (${request.scale.min}-${request.scale.max}), optional note after a space: `);
      const [head, ...rest] = answer.trim().split(" ");
      return { rating: Number(head), note: rest.join(" ") || undefined };
    }
    const answer = await rl.question("Pass? (y/n), optional note after a space: ");
    const [head, ...rest] = answer.trim().split(" ");
    return { pass: head.toLowerCase().startsWith("y"), note: rest.join(" ") || undefined };
  } finally {
    rl.close();
  }
};
