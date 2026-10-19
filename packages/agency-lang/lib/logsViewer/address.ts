// An address names one row of one trace: `<trace id>/<row id>`. It is what
// the viewer copies with `A`, what a comment is stored against, and what the
// `agency logs session` commands take. The row id is opaque here: rows are
// found by looking the id up in the story, never by parsing it (see "Row IDs
// are a contract" in docs/dev/cli/logs-viewer.md).

export type Address = { traceId: string; rowId: string };

const SEPARATOR = "/";

export function formatAddress(traceId: string, rowId: string): string {
  return `${traceId}${SEPARATOR}${rowId}`;
}

/**
 * Split on the LAST slash. A trace id is whatever the statelog config or the
 * trace-id environment variable supplied, slashes included; a row id never
 * contains one (span ids, ordinals, and fixed event types).
 */
export function parseAddress(text: string): Address | { error: string } {
  const at = text.lastIndexOf(SEPARATOR);
  if (at === -1) {
    return { error: `${text} is not an address: expected <trace id>/<row id>` };
  }
  const traceId = text.slice(0, at);
  const rowId = text.slice(at + 1);
  if (traceId.length === 0 || rowId.length === 0) {
    return { error: `${text} is not an address: both the trace id and the row id are needed` };
  }
  return { traceId, rowId };
}

export function isAddress(value: Address | { error: string }): value is Address {
  return !("error" in value);
}
