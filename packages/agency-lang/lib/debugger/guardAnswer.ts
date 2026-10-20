import type { InterruptResponse } from "../runtime/interrupts.js";

/** What a `std::guard` interrupt carries (see docs/site/guide/guards.md,
 *  "The interrupt payload"). */
export type GuardTripData = {
  dimension: "cost" | "time";
  limit: number;
  spent: number;
  label: string | null;
  draftValue: unknown;
};

export function isGuardTrip(effect: string, data: unknown): data is GuardTripData {
  return effect === "std::guard" && typeof data === "object" && data !== null;
}

/** The lines the activity log shows for a trip: which guard, what it
 *  spent against what limit, and what a reject would return. */
export function describeGuardTrip(data: GuardTripData): string[] {
  const name = data.label ? `Guard "${data.label}"` : "A guard";
  const amount =
    data.dimension === "cost"
      ? `$${data.spent.toFixed(6)} spent of $${data.limit}`
      : `${Math.round(data.spent)}ms elapsed of ${data.limit}ms`;
  const draft =
    data.draftValue === null || data.draftValue === undefined
      ? "No saved draft: a reject returns a failure"
      : `Draft a reject returns: ${JSON.stringify(data.draftValue)}`;
  return [`${name} tripped on ${data.dimension}: ${amount}`, draft];
}

/** The answers, as the input field's label. It shares one row with the
 *  typed answer, so it is kept short; the trip itself is described in
 *  the activity log. */
export const GUARD_ANSWER_HELP =
  "grant cost|time <amount> / disarm cost|time / message <text> / reject";

type GuardGrant = {
  maxCost?: number;
  maxTime?: number;
  disarm?: ("cost" | "time")[];
  message?: string;
};

/** Read an answer to a guard trip. The pieces may be combined in one
 *  line, the message last: `grant cost 0.5 message finish up`. A
 *  message or nothing on its own is refused here rather than by the
 *  runtime, which would throw: the trip needs a grant or a disarm. */
export function parseGuardAnswer(
  text: string,
): { response: InterruptResponse } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "reject" || trimmed === "r") {
    return { response: { type: "reject" } };
  }
  const grant: GuardGrant = {};
  const words = trimmed.split(/\s+/);
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === "grant") {
      const dimension = parseDimension(words[i + 1]);
      if (!dimension)
        return { error: `grant needs a dimension, cost or time: ${GUARD_ANSWER_HELP}` };
      const amount =
        dimension === "cost" ? parseDollars(words[i + 2]) : parseDuration(words[i + 2]);
      if (amount === null) {
        return {
          error: `grant ${dimension} needs an amount${dimension === "time" ? " such as 30s or 2m" : " in dollars"}`,
        };
      }
      if (dimension === "cost") grant.maxCost = amount;
      else grant.maxTime = amount;
      i += 3;
    } else if (word === "disarm") {
      const dimension = parseDimension(words[i + 1]);
      if (!dimension)
        return { error: `disarm needs a dimension, cost or time: ${GUARD_ANSWER_HELP}` };
      grant.disarm = [...(grant.disarm ?? []), dimension];
      i += 2;
    } else if (word === "message") {
      const message = words.slice(i + 1).join(" ");
      if (message === "") return { error: "message needs the text to send the model" };
      grant.message = message;
      i = words.length;
    } else {
      return { error: `Unknown answer: "${trimmed}". Try: ${GUARD_ANSWER_HELP}` };
    }
  }
  if (grant.maxCost === undefined && grant.maxTime === undefined && grant.disarm === undefined) {
    return { error: `A guard trip needs a grant or a disarm, or a reject: ${GUARD_ANSWER_HELP}` };
  }
  return { response: { type: "approve", value: grant } as InterruptResponse };
}

function parseDimension(word: string | undefined): "cost" | "time" | null {
  return word === "cost" || word === "time" ? word : null;
}

function parseDollars(word: string | undefined): number | null {
  if (word === undefined) return null;
  const amount = Number(word.replace(/^\$/, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** A duration in milliseconds, written as the guide's unit literals:
 *  `100ms`, `30s`, `2m`, `1h`, or a bare number of milliseconds. */
function parseDuration(word: string | undefined): number | null {
  const match = word?.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return null;
  const amount = Number(match[1]) * DURATION_UNITS[match[2] ?? "ms"];
  return amount > 0 ? amount : null;
}
