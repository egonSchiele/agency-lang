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
 * Split an address against the trace ids of the log it names. No character
 * can do it alone: a trace id may contain slashes (a hosted run), and a row
 * directly under the trace root embeds the trace id in its own id
 * (`leaf:trace-<trace id>:error:0`). The longest trace id that starts the
 * text, followed by a slash, is the trace; the rest is the row. Undefined
 * when no trace id starts it, in which case the text is a bare row id.
 */
export function splitAddress(text: string, traceIds: readonly string[]): Address | undefined {
  const traceId = [...traceIds]
    .filter((candidate) => text.startsWith(`${candidate}${SEPARATOR}`))
    .sort((first, second) => second.length - first.length)[0];
  if (traceId === undefined) {
    return undefined;
  }
  const rowId = text.slice(traceId.length + SEPARATOR.length);
  return rowId.length === 0 ? undefined : { traceId, rowId };
}
