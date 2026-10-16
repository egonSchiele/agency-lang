/**
 * Where a span id waits for a resume.
 *
 * A span's id is random, and a resumed run rebuilds every open span in a
 * new process. A site whose span can still be open when a checkpoint is
 * taken saves the id in a slot: a key under `SPAN_SLOT_PREFIX` in a record
 * the checkpoint serializes, such as a frame's locals. `reopenSpan` on the
 * statelog client reads the slot and opens the span with the saved id, so
 * the resumed events land in the span the paused run started.
 *
 * The slot's lifetime is the id's lifetime. A frame local dies when its
 * frame is popped, which happens on completion and on a throw but not on a
 * pause, so no site writes a clear.
 *
 * A saved id is reused only inside the trace that minted it. A rewind or a
 * CLI resume that starts a new trace gets fresh spans: the trace check
 * fails and a new id is written over the old one.
 */
export const SPAN_SLOT_PREFIX = "__span_";

/** A slot: a key under the prefix in `locals`. Sites name the slot without
 *  the prefix, as `"llmCall"` or a tool invocation's key. */
export type SpanSlot = { locals: Record<string, unknown>; key: string };

export function spanSlot(locals: Record<string, unknown>, name: string): SpanSlot {
  return { locals, key: `${SPAN_SLOT_PREFIX}${name}` };
}

/** What a slot holds: the span id and the trace it belongs to. */
export type SavedSpan = { traceId: string; spanId: string };

/** Twelve characters of the nanoid alphabet, the shape `startSpan` mints. */
const SPAN_ID_SHAPE = /^[A-Za-z0-9_-]{12}$/;

/** The span id saved in `slot`, if it is well formed and belongs to
 *  `traceId`. The checkpoint is the program, so the shape is checked before
 *  the id goes into every event's `span_id`. */
export function savedSpanIdFor(slot: SpanSlot, traceId: string): string | undefined {
  const saved = slot.locals[slot.key];
  if (typeof saved !== "object" || saved === null) return undefined;
  const { traceId: savedTrace, spanId } = saved as Partial<SavedSpan>;
  if (savedTrace !== traceId) return undefined;
  if (typeof spanId !== "string" || !SPAN_ID_SHAPE.test(spanId)) return undefined;
  return spanId;
}

export function saveSpan(slot: SpanSlot, saved: SavedSpan): void {
  slot.locals[slot.key] = saved;
}
