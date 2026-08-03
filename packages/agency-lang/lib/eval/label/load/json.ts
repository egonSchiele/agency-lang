import type { Fields } from "../types.js";

import { checkEligibility } from "./eligibility.js";
import {
  IngestSourceError,
  type IngestSkip,
  type LoadedBatch,
  type LoadedOccurrence,
} from "./types.js";

export type LoadJsonArrayArgs = {
  /** Normalized path of the document relative to its batch root. Part of every
   *  occurrence's identity, so equal strings in two documents stay two
   *  observations. */
  itemKey: string;
  text: string;
  source: string;
  constantFields: Fields;
  maxBytes: number;
};

/** A quick paste of several outputs: a top-level array of strings. */
export function loadJsonArray(args: LoadJsonArrayArgs): LoadedBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.text);
  } catch (error) {
    throw new IngestSourceError(
      `${args.itemKey} is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new IngestSourceError(
      `${args.itemKey} must hold a top-level array of strings, one per output. ` +
      `Found ${describeJsonType(parsed)}.`,
    );
  }

  const occurrences: LoadedOccurrence[] = [];
  const skips: IngestSkip[] = [];
  const fieldNames: Record<string, true> = Object.create(null);

  for (let index = 0; index < parsed.length; index += 1) {
    const element: unknown = parsed[index];
    // Coercing would turn a mistake into a labelable record. A number in this
    // array is a typo, not data.
    if (typeof element !== "string") {
      throw new IngestSourceError(
        `${args.itemKey}: element ${index} is ${describeJsonType(element)}, but every ` +
        "element must be a string holding one output.",
      );
    }

    const ineligible = checkEligibility(element, { maxBytes: args.maxBytes });
    if (ineligible !== undefined) {
      skips.push({ item: `${args.itemKey}[${index}]`, reason: ineligible });
      continue;
    }

    const fields: Fields = { ...args.constantFields, output: element };
    for (const name of Object.keys(fields)) {
      fieldNames[name] = true;
    }
    occurrences.push({
      fields,
      source: args.source,
      origin: { kind: "json", itemKey: args.itemKey, itemIndex: index },
    });
  }

  return { occurrences, skips, discoveredFieldNames: Object.keys(fieldNames) };
}

function describeJsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  const type = typeof value;
  return type === "object" ? "an object" : `a ${type}`;
}
