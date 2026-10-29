/**
 * The subprocess wall clock a workflow runs under. A workflow's `maxTime`
 * is enforced by the guard inside the generated program; the wall clock is
 * the process limit behind it, so it sits a little above `maxTime`. With
 * no `maxTime`, `run` applies its own default.
 */
import { LIMIT_CEILINGS } from "../../runtime/ipc.js";
import type { Limits } from "./types.js";

/** Headroom between the guard's time limit and the process being killed. */
export const WALL_CLOCK_HEADROOM = 30000;

/** The largest `maxTime` a workflow or step may ask for: `run`'s wall clock
 *  ceiling less the headroom, so the wall clock never exceeds the ceiling. */
export const MAX_TIME = LIMIT_CEILINGS.wallClock - WALL_CLOCK_HEADROOM;

/** How a limit must print to be an Agency number literal: digits and an
 *  optional fraction. `1e-7` and `1e+21`, which `0.0000001` and
 *  `1000000000000000000000` print as, do not parse. Parse refuses a limit
 *  that prints any other way, and the `limits` token check accepts only this. */
export const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

export function wallClockFor(limits: Limits | null): number | null {
  if (limits === null || limits.maxTime === undefined) {
    return null;
  }
  return limits.maxTime + WALL_CLOCK_HEADROOM;
}
