/**
 * Per-document state, with a retention rule.
 *
 * The server rebuilds document state on a debounce, and a failed parse
 * produces no state at all. Features that answer a request per keystroke
 * therefore see "no state" constantly while the user types a line — most
 * of the time the buffer is simply half-written.
 *
 * For a feature like go-to-definition that is fine: no state, no answer,
 * and the user sees nothing missing. For semantic tokens it is not, because
 * "no answer" means every colour in the file disappears until the line
 * parses again.
 *
 * So this cache keeps two things per document: the CURRENT state, which
 * goes away when a parse fails, and the LAST GOOD state, which does not.
 * Callers that need an answer on every keystroke read `getLastGood`.
 * Colours lagging the cursor by a debounce are invisible; colours
 * vanishing are not.
 *
 * It lives in its own module rather than as two Maps inside `startServer`
 * so the retention rule has one home instead of being re-decided at each
 * call site, and so it can be tested — the behaviour it exists for only
 * shows up across a sequence of updates.
 */
import type { DocumentState } from "./documentState.js";

export class DocumentStateCache {
  // Null-prototype: the keys are document URIs, which come from the
  // client. A plain object would resolve names like `__proto__` or
  // `toString` off the prototype chain rather than reporting a miss.
  // No URI can currently collide, but the guard costs nothing and the
  // keys are not ours to constrain.
  private current: Record<string, DocumentState> = Object.create(null);
  private lastGood: Record<string, DocumentState> = Object.create(null);

  /** Record a successful build. */
  set(uri: string, state: DocumentState): void {
    this.current[uri] = state;
    this.lastGood[uri] = state;
  }

  /** Record that the document no longer has usable state — a failed
   *  parse. The last good state deliberately survives. */
  clearCurrent(uri: string): void {
    delete this.current[uri];
  }

  /** The state for this document right now, or undefined if the latest
   *  parse failed. */
  get(uri: string): DocumentState | undefined {
    return this.current[uri];
  }

  /**
   * The most recent state that parsed, even if the buffer has since
   * stopped parsing or moved on. May be older than the document — a
   * caller that cares can compare `state.version` against the document,
   * but for highlighting, stale beats absent.
   */
  getLastGood(uri: string): DocumentState | undefined {
    return this.lastGood[uri];
  }

  /** Forget the document entirely. For close, where retention would be
   *  a leak rather than a feature. */
  remove(uri: string): void {
    delete this.current[uri];
    delete this.lastGood[uri];
  }

  /** Any current state, for requests that are document-independent
   *  (workspace symbols). */
  anyCurrent(): DocumentState | undefined {
    return Object.values(this.current)[0];
  }
}
