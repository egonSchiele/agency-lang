import * as fs from "fs";

import { StatelogParser } from "../statelogParser.js";

export type EvalExtractOptions = {
  out?: string;
  previewChars?: number;
  /** Pretty-print the output JSON. True by default. */
  pretty?: boolean;
};

/** CLI entry point for `agency eval extract`. */
export async function evalExtract(
  file: string,
  opts: EvalExtractOptions = {},
): Promise<void> {
  const record = new StatelogParser(file, {
    previewChars: opts.previewChars,
  }).evalRecord();
  const outPath = opts.out ?? defaultOutPath(file);
  const pretty = opts.pretty !== false;
  fs.writeFileSync(outPath, JSON.stringify(record, null, pretty ? 2 : 0));
  console.log(
    `Wrote eval record to ${outPath} (${record.events.length} events, ` +
      `${record.threads.length} threads, ` +
      `${record.incomplete.length} incomplete)`,
  );
}

function defaultOutPath(input: string): string {
  return `${stripJsonlSuffix(input)}.eval.json`;
}

/** Strip `.statelog.jsonl` or `.jsonl` from the end of a path,
 *  returning the original path unchanged if neither suffix is
 *  present. Split out so `defaultOutPath` reads declaratively
 *  instead of nesting ternaries. */
function stripJsonlSuffix(input: string): string {
  for (const suffix of [".statelog.jsonl", ".jsonl"]) {
    if (input.endsWith(suffix)) return input.slice(0, -suffix.length);
  }
  return input;
}
