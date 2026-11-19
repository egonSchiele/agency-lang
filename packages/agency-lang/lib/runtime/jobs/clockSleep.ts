import type { Clock } from "../clock.js";

/** A wait on the host's clock that can be cancelled, so code whose work
 *  is done does not wait out a timer before its process can exit. Tests
 *  move a FakeClock to end it. */
export function clockSleep(clock: Clock, ms: number): { done: Promise<void>; cancel: () => void } {
  let handle: ReturnType<Clock["setTimer"]> | null = null;
  const done = new Promise<void>((resolve) => {
    handle = clock.setTimer(resolve, ms);
  });
  return {
    done,
    cancel: () => {
      if (handle !== null) {
        clock.clearTimer(handle);
      }
    },
  };
}
