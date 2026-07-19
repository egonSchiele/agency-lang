export type TimerHandle = { id: number };

/**
 * The seam every guard time read and timer goes through. The real clock is
 * the default; tests swap in a FakeClock to advance time deterministically.
 * See docs/superpowers/specs/2026-07-19-fake-clock-time-guards-design.md.
 */
export type Clock = {
  /** Monotonic milliseconds. What a time guard meters against. */
  now(): number;
  /** Milliseconds since the Unix epoch. What std::date reads. Unused today;
   *  here so issue #609 can reroute std::date through this seam later. */
  wallTime(): number;
  setTimer(fn: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
};

export const realClock: Clock = {
  now: () => performance.now(),
  wallTime: () => Date.now(),
  setTimer: (fn, delayMs) => ({
    id: setTimeout(fn, delayMs) as unknown as number,
  }),
  clearTimer: (handle) => clearTimeout(handle.id),
};

export class FakeClock implements Clock {
  private monotonicMs = 0;
  // Base for wall time. Zero for now, so a frozen calendar reads as 1970.
  // Nothing calls wallTime() in this feature, so it does not matter yet. When
  // #609 wires std::date through the seam, seed this from a realistic epoch so
  // a test reading "today" does not get 1970. Known follow-up, not a bug here.
  private wallBaseMs = 0;
  private timers: { dueAt: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.monotonicMs;
  }

  wallTime(): number {
    return this.wallBaseMs + this.monotonicMs;
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ dueAt: this.monotonicMs + delayMs, fn, id });
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle.id);
  }

  /**
   * Move the clock forward `ms` and fire every timer due within that span.
   * Terminates: nothing here arms a timer, and each iteration removes one, so
   * the pending list strictly shrinks. A guard timer's callback only aborts;
   * it never re-arms (re-arming is startWindow, which runs at a later runner
   * step), so there is no runaway and no firing cap.
   */
  advance(ms: number): void {
    const target = this.monotonicMs + ms;
    while (true) {
      // The earliest timer still due within the span. Re-computed each pass,
      // because a fired callback may have armed a new one.
      const due = this.earliestDueBy(target);
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.monotonicMs = due.dueAt; // step to the timer, then fire it
      due.fn();
    }
    this.monotonicMs = target;
  }

  private earliestDueBy(
    target: number,
  ): { dueAt: number; fn: () => void; id: number } | undefined {
    return this.timers.reduce<
      { dueAt: number; fn: () => void; id: number } | undefined
    >((earliest, t) => {
      if (t.dueAt > target) return earliest;
      if (!earliest || t.dueAt < earliest.dueAt) return t;
      return earliest;
    }, undefined);
  }
}
