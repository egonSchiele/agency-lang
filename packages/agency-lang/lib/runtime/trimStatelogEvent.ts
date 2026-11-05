/*
 * The size cap on statelog events. One number bounds two things: every
 * string in an event, and every top-level field of the event's `data`. A
 * value under the cap is logged as it is. See docs/dev/hosting/statelog.md,
 * "Size cap".
 */

/** The cap when the config sets none. It matches eval's cap on an output and
 *  the default `client.maxToolResultChars`, so the log keeps everything eval
 *  and a model could see. */
export const DEFAULT_MAX_VALUE_CHARS = 100_000;

/** The key that stands in for the keys an object lost. */
export const TRUNCATED_KEY = "__truncated";

/** What `promptCompletion` keeps whole: the end of a conversation is the part
 *  worth reading, and a budget keeps the start. Each message's strings are
 *  still capped. */
const UNBUDGETED_FIELDS: Record<string, string[]> = {
  promptCompletion: ["messages"],
};

/**
 * Cut `text` so that, with its marker, it is at most `maxChars` characters:
 * `xxxx…[truncated 115,748 chars]`, where the number is how many were
 * removed. Fitting the marker inside the cap means a capped string never
 * goes over a field budget of the same size and gets cut a second time.
 * Calls `onCut` when it cuts. A `maxChars` of `0` means no cap.
 *
 * A string is never swapped for a longer one. When a field's budget is
 * nearly spent, `"row 2683"` would otherwise become `"…[truncated 8 chars]"`;
 * it is kept as it is.
 */
export function capString(text: string, maxChars: number, onCut: () => void): string {
  if (maxChars === 0 || text.length <= maxChars) {
    return text;
  }
  // At most `text.length` characters are removed, so this marker is at
  // least as long as the one written.
  const longestMarker = truncationMarker(text.length);
  const kept = Math.max(maxChars - longestMarker.length, 0);
  const cut = text.slice(0, kept) + truncationMarker(text.length - kept);
  if (cut.length >= text.length) {
    return text;
  }
  onCut();
  return cut;
}

function truncationMarker(removed: number): string {
  return `…[truncated ${removed.toLocaleString("en-US")} chars]`;
}

/** How many characters of a field are left to spend, and whether anything
 *  was cut to stay within them. */
type Budget = { left: number; cut: boolean };

/**
 * Trim one value to about `maxChars` characters of JSON. The value is walked
 * in order, counting what it serializes to: a scalar costs its JSON length
 * plus one for the comma, a key its JSON length plus one for the colon, and
 * an array or object two for its brackets. Once the budget is spent, the rest
 * of an array becomes one item, `[truncated: 131 more items]`, the rest of an
 * object becomes one key, `"__truncated": "12 more keys"`, and a string is cut
 * to what is left. Everything before the cut is kept whole.
 */
export function trimField(value: unknown, maxChars: number): { value: unknown; cut: boolean } {
  const budget: Budget = { left: maxChars, cut: false };
  const trimmed = trimValue(value, budget);
  return { value: trimmed, cut: budget.cut };
}

function trimValue(value: unknown, budget: Budget): unknown {
  if (Array.isArray(value)) {
    return trimArray(value, budget);
  }
  if (value !== null && typeof value === "object") {
    return trimObject(value as Record<string, unknown>, budget);
  }
  return trimScalar(value, budget);
}

function trimScalar(value: unknown, budget: Budget): unknown {
  const kept =
    typeof value === "string"
      ? capString(value, Math.max(budget.left, 1), () => {
          budget.cut = true;
        })
      : value;
  budget.left -= JSON.stringify(kept ?? null).length + 1;
  return kept;
}

function trimArray(items: unknown[], budget: Budget): unknown[] {
  budget.left -= 2;
  const kept: unknown[] = [];
  for (const item of items) {
    if (budget.left <= 0) {
      budget.cut = true;
      kept.push(`[truncated: ${items.length - kept.length} more items]`);
      return kept;
    }
    kept.push(trimValue(item, budget));
  }
  return kept;
}

function trimObject(record: Record<string, unknown>, budget: Budget): Record<string, unknown> {
  budget.left -= 2;
  const entries = Object.entries(record);
  const kept: Record<string, unknown> = {};
  for (const [index, [key, value]] of entries.entries()) {
    if (budget.left <= 0) {
      budget.cut = true;
      kept[TRUNCATED_KEY] = `${entries.length - index} more keys`;
      return kept;
    }
    budget.left -= JSON.stringify(key).length + 1;
    kept[key] = trimValue(value, budget);
  }
  return kept;
}

/**
 * Trim each top-level field of an event's `data` to `maxChars`, each with its
 * own budget, so one large field cannot push the small ones (`usage`, `cost`)
 * out of the event. `promptCompletion.messages` is left whole.
 */
export function trimEventData(
  data: Record<string, unknown>,
  maxChars: number,
): { data: Record<string, unknown>; cut: boolean } {
  const unbudgeted = UNBUDGETED_FIELDS[String(data.type)] ?? [];
  const trimmed: Record<string, unknown> = {};
  let cut = false;
  for (const [key, value] of Object.entries(data)) {
    if (unbudgeted.includes(key)) {
      trimmed[key] = value;
      continue;
    }
    const field = trimField(value, maxChars);
    trimmed[key] = field.value;
    cut = cut || field.cut;
  }
  return { data: trimmed, cut };
}

/**
 * Bound an event that was already serialized and scrubbed. `stringCut` says
 * whether the serializer cut a string on the way. An event that lost nothing
 * comes back as the same text. One that lost anything is parsed, its fields
 * are trimmed, and it is written again with `truncated: true` on `data`.
 *
 * The text, not the live value, is trimmed so redaction keeps working: redact
 * tags live on the original objects, and a trimmed copy would not carry them.
 */
export function trimStatelogText(text: string, maxChars: number, stringCut: boolean): string {
  if (maxChars === 0) {
    return text;
  }
  // A text no longer than the cap cannot hold a field over it.
  if (text.length <= maxChars && !stringCut) {
    return text;
  }
  const event = JSON.parse(text) as { data: Record<string, unknown> };
  const trimmed = trimEventData(event.data, maxChars);
  // Written again only when something changed: a parse and stringify can
  // reorder integer-like keys.
  if (!trimmed.cut && !stringCut) {
    return text;
  }
  return JSON.stringify({ ...event, data: { ...trimmed.data, truncated: true } });
}
