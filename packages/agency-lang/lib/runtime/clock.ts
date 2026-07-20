export type TimerHandle = { id: ReturnType<typeof setTimeout> | number };

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
  setTimer: (fn, delayMs) => ({ id: setTimeout(fn, delayMs) }),
  clearTimer: (handle) => clearTimeout(handle.id as ReturnType<typeof setTimeout>),
};

/** The wall-clock epoch a fresh FakeClock reports as "now" (before any advance).
 *  A realistic date, not 0, so a fixture reading today()/format(now()) under a
 *  fake clock gets 2026, not 1970. std::date reads wallTime() (#609), so this is
 *  load-bearing — clock.test.ts references this constant, not a literal. */
export const FAKE_CLOCK_WALL_BASE_MS = Date.UTC(2026, 0, 1);

export class FakeClock implements Clock {
  private monotonicMs = 0;
  private wallBaseMs = FAKE_CLOCK_WALL_BASE_MS;
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
   *
   * Termination: in this codebase's usage the loop always ends. A guard
   * timer's callback only aborts; it never re-arms (re-arming is startWindow,
   * which runs at a later runner step), and every guard delay is >= 0, so each
   * iteration removes one timer and no callback adds one that is due earlier.
   * The loop is NOT proof against an arbitrary caller that arms a fresh 0ms
   * timer from inside a fired callback — that is a hypothetical no code here
   * does, so there is no firing cap. The guard below rejects the one misuse
   * that is easy to hit by accident: a negative or NaN advance, which would
   * move the clock backward or corrupt it.
   */
  advance(ms: number): void {
    if (!(ms >= 0)) {
      // Catches negative and NaN (NaN fails every comparison).
      throw new Error(`advance(${ms}): ms must be a non-negative number.`);
    }
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
