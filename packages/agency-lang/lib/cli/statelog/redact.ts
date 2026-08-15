// One concept: removing known secret values from untrusted display text.
// Callers pass the values they know are sensitive (an API key, a submitted
// secret); anything a server, proxy, or exception echoed back is replaced
// before the text can reach an error message or the terminal.

/** Replace every occurrence of each non-empty value with "[redacted]". Runs
 *  BEFORE any escaping/formatting so formatting can never split a value out of
 *  the redactor's reach. Split/join, not RegExp — a value full of regex
 *  metacharacters must stay a literal match. Longer values are replaced first:
 *  if one value is a prefix of another, replacing the short one first would
 *  destroy the long one's match and leak its suffix. Empty values are skipped
 *  (they would match everywhere). */
export function redactValues(text: string, values: string[]): string {
  const longestFirst = values.filter((value) => value !== "").sort((a, b) => b.length - a.length);
  let redacted = text;
  for (const value of longestFirst) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}
