/**
 * The subprocess wall clock a workflow runs under. A workflow's `maxTime`
 * is enforced by the guard inside the generated program; the wall clock is
 * the process limit behind it, so it sits a little above `maxTime`. With
 * no `maxTime`, `run` applies its own default.
 */
import type { Limits } from "./types.js";

/** Headroom between the guard's time limit and the process being killed. */
export const WALL_CLOCK_HEADROOM = 30000;

export function wallClockFor(limits: Limits | null): number | null {
  if (limits === null || limits.maxTime === undefined) {
    return null;
  }
  return limits.maxTime + WALL_CLOCK_HEADROOM;
}
