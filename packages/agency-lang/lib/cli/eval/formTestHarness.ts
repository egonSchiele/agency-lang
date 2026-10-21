// Drives the test form headlessly: each key is fed once the recorded frame
// shows the state a person would react to. Shared by the `eval new` and
// `eval edit` tests, so there is one poller that asserts its own step count.
import { expect } from "vitest";

import type { ScriptedInput } from "@/tui/input/scripted.js";
import type { KeyEvent } from "@/tui/input/types.js";
import type { FrameRecorder } from "@/tui/output/recorder.js";

export type Step = { when: (frame: string) => boolean; key: KeyEvent | string };

function lastFrame(recorder: FrameRecorder): string {
  return recorder.frames.length === 0 ? "" : recorder.lastText();
}

/** Run the form while a poller feeds each key once the screen shows the
 *  state a person would react to. */
export async function drive(
  run: () => Promise<void>,
  input: ScriptedInput,
  recorder: FrameRecorder,
  steps: Step[],
): Promise<void> {
  let at = 0;
  const timer = setInterval(() => {
    if (at < steps.length && steps[at].when(lastFrame(recorder))) {
      const key = steps[at].key;
      input.feedKey(typeof key === "string" ? { key } : key);
      at += 1;
    }
  }, 1);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  expect(at).toBe(steps.length);
}

export function typing(text: string): Step[] {
  return [...text].map((key) => ({ when: () => true, key }));
}

export const shown = (text: string) => (frame: string) => frame.includes(text);
export const ctrl = (key: string): KeyEvent => ({ key, ctrl: true });
export const times = (key: string, count: number): Step[] =>
  Array.from({ length: count }, () => ({ when: () => true, key }));
