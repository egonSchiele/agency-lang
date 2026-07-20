import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeClock, realClock } from "./clock.js";

describe("FakeClock", () => {
  it("starts at zero and advances now() and wallTime() together", () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(0);
    expect(clock.wallTime()).toBe(0);
    clock.advance(200);
    expect(clock.now()).toBe(200);
    expect(clock.wallTime()).toBe(200);
  });

  it("fires a timer whose due time falls within the advance", () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimer(() => {
      fired = true;
    }, 100);
    clock.advance(50);
    expect(fired).toBe(false);
    clock.advance(60); // now at 110, past the 100ms timer
    expect(fired).toBe(true);
  });

  it("fires a timer due exactly at the advance target (dueAt === target boundary)", () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimer(() => {
      fired = true;
    }, 100);
    clock.advance(100); // lands exactly on the due time
    expect(fired).toBe(true);
  });

  it("does not fire a timer that was cleared", () => {
    const clock = new FakeClock();
    let fired = false;
    const handle = clock.setTimer(() => {
      fired = true;
    }, 100);
    clock.clearTimer(handle);
    clock.advance(200);
    expect(fired).toBe(false);
  });

  it("fires multiple distinct timers due within one advance, in due order", () => {
    const clock = new FakeClock();
    const order: number[] = [];
    clock.setTimer(() => order.push(2), 200);
    clock.setTimer(() => order.push(1), 100);
    clock.advance(300);
    expect(order).toEqual([1, 2]);
  });

  it("sets now() to each timer's due time before firing it", () => {
    const clock = new FakeClock();
    let seen = -1;
    clock.setTimer(() => {
      seen = clock.now();
    }, 100);
    clock.advance(500);
    expect(seen).toBe(100); // not 500
  });

  it("terminates when a fired callback is a no-op (no re-arm)", () => {
    const clock = new FakeClock();
    let count = 0;
    clock.setTimer(() => {
      count++;
    }, 100);
    clock.advance(1000);
    expect(count).toBe(1);
    expect(clock.now()).toBe(1000);
  });

  it("fires a timer that a callback arms WITHIN the same advance span", () => {
    // Pins the re-entrancy invariant: advance() re-reads the pending list
    // after each firing, so a timer armed by a fired callback and due before
    // the target fires in the same advance() call. A one-shot snapshot loop
    // would silently break this.
    const clock = new FakeClock();
    let inner = false;
    clock.setTimer(() => {
      clock.setTimer(() => {
        inner = true;
      }, 50); // due at 100 + 50 = 150
    }, 100);
    clock.advance(300); // 150 <= 300, so the inner timer must fire too
    expect(inner).toBe(true);
  });

  it("rejects a negative or NaN advance rather than corrupting the clock", () => {
    const clock = new FakeClock();
    expect(() => clock.advance(-5)).toThrow(/non-negative/);
    expect(() => clock.advance(NaN)).toThrow(/non-negative/);
    expect(clock.now()).toBe(0); // unchanged by the rejected calls
  });

  it("does NOT fire a timer a callback arms beyond the advance target", () => {
    const clock = new FakeClock();
    let inner = false;
    clock.setTimer(() => {
      clock.setTimer(() => {
        inner = true;
      }, 500); // due at 100 + 500 = 600
    }, 100);
    clock.advance(300); // 600 > 300, so the inner timer must NOT fire
    expect(inner).toBe(false);
  });
});

describe("realClock", () => {
  afterEach(() => vi.useRealTimers());
  it("delegates to global timers", () => {
    vi.useFakeTimers();
    let fired = false;
    const handle = realClock.setTimer(() => {
      fired = true;
    }, 100);
    vi.advanceTimersByTime(50);
    expect(fired).toBe(false);
    vi.advanceTimersByTime(60);
    expect(fired).toBe(true);
    realClock.clearTimer(handle); // no throw on an already-fired handle
  });
});
