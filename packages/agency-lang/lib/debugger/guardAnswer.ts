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

/** Which guard tripped and what it spent against its limit. */
export function describeGuardTrip(data: GuardTripData): string {
  const name = data.label ? `Guard "${data.label}"` : "A guard";
  return `${name} tripped on ${data.dimension}: ${amountText(data.dimension, data.spent)} spent of ${amountText(data.dimension, data.limit)}`;
}

/** What a reject may give back. The draft is a preview of the innermost
 *  saved draft; a `finalize` can replace it, so it is not a promise. */
export function draftNote(data: GuardTripData): string {
  return data.draftValue === null || data.draftValue === undefined
    ? "No saved draft: a reject returns a failure, unless a finalize gives a partial result"
    : `A reject may return the saved draft: ${JSON.stringify(data.draftValue)}`;
}

/** The three ways to answer a trip, in the order the form lists them. */
export type GuardChoice = "grant" | "removeLimit" | "reject";

export function guardChoices(data: GuardTripData): { choice: GuardChoice; label: string }[] {
  return [
    { choice: "grant", label: "Approve with more budget" },
    { choice: "removeLimit", label: `Remove the ${data.dimension} limit` },
    { choice: "reject", label: "Reject" },
  ];
}

export function amountPrompt(data: GuardTripData): string {
  return data.dimension === "cost"
    ? "How much more cost? ($)"
    : "How much more time? (30s, 2m, or milliseconds)";
}

export const MESSAGE_PROMPT = "Message to the model (optional)";

/** The amount a person typed, in the dimension's unit: dollars, or
 *  milliseconds written as the guide's unit literals (`100ms`, `30s`,
 *  `2m`, `1h`) or a bare number. Null when it is not an amount. */
export function parseAmount(dimension: "cost" | "time", text: string): number | null {
  const trimmed = text.trim();
  if (dimension === "cost") {
    const amount = Number(trimmed.replace(/^\$/, ""));
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return null;
  const amount = Number(match[1]) * DURATION_UNITS[match[2] ?? "ms"];
  return amount > 0 ? amount : null;
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Why a grant of `amount` would be refused by the runtime, or null when
 *  it clears the trip. The runtime throws on an answer that leaves the
 *  tripped budget exceeded, since the guard would trip again at once. */
export function checkGrant(data: GuardTripData, amount: number): string | null {
  const shortfall = data.spent - data.limit;
  if (amount > shortfall) return null;
  return `The ${data.dimension} budget would still be exceeded: the grant must be more than ${amountText(data.dimension, shortfall)}`;
}

/** The response the runtime understands for a choice: `approve` with a
 *  grant on the tripped dimension, with its disarm, or `reject`. */
export function guardResponse(
  data: GuardTripData,
  choice: GuardChoice,
  amount: number | null,
  message: string,
): InterruptResponse {
  if (choice === "reject") return { type: "reject" };
  const value: Record<string, unknown> = {};
  if (choice === "grant") value[data.dimension === "cost" ? "maxCost" : "maxTime"] = amount;
  if (choice === "removeLimit") value.disarm = [data.dimension];
  if (message.trim() !== "") value.message = message.trim();
  return { type: "approve", value } as InterruptResponse;
}

function amountText(dimension: "cost" | "time", amount: number): string {
  return dimension === "cost" ? `$${Number(amount.toFixed(6))}` : `${Math.round(amount)}ms`;
}
