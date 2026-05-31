import type { Element } from "./elements.js";
import type { InputSource, KeyEvent } from "./input/types.js";
import type { OutputTarget } from "./output/types.js";
import { layout } from "./layout.js";
import { render } from "./render/renderer.js";
import { Frame } from "./frame.js";

export class Screen {
  private output: OutputTarget;
  private input: InputSource;
  private width: number;
  private height: number;

  constructor(opts: { output: OutputTarget; input: InputSource; width: number; height: number }) {
    this.output = opts.output;
    this.input = opts.input;
    this.width = opts.width;
    this.height = opts.height;
  }

  render(root: Element, label?: string): Frame {
    const positioned = layout(root, this.width, this.height);
    const frame = render(positioned);
    this.output.write(frame, label);
    return frame;
  }

  nextKey(): Promise<KeyEvent> {
    return this.input.nextKey();
  }

  nextLine(prompt: string): Promise<string> {
    return this.input.nextLine(prompt);
  }

  size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  async runLoop<S>(opts: {
    initialState: S;
    render: (state: S) => Element | Promise<Element>;
    handleKey: (state: S, event: KeyEvent) => S | Promise<S>;
    isDone: (state: S) => boolean | Promise<boolean>;
    label?: string;
    /**
     * If set, the loop races each `nextKey()` against a `setTimeout`
     * of `tickMs` milliseconds. On a tick, it re-renders with the
     * current state (no transition). On a key, it runs `handleKey`
     * then re-renders. Used by `repl()` to keep a live status line
     * ticking while no keys arrive (e.g. during a long LLM call).
     *
     * When omitted, the loop is pure event-driven: it blocks on
     * `nextKey()` and re-renders only after each keypress.
     *
     * Note: the losing side of the race leaves a pending
     * `nextKey()` promise; the next loop iteration awaits the same
     * promise. `ScriptedInput` (multi-waiter queue) and
     * `TerminalInput` (readline) both tolerate this safely.
     */
    tickMs?: number;
  }): Promise<S> {
    // The render / handleKey / isDone callbacks may be async — the
    // declarative bridge in `lib/stdlib/ui.ts` adapts Agency callback
    // values into async wrappers (Agency functions invoke through the
    // runtime call path which returns a Promise). Pure-TS callers can
    // still pass sync functions; the awaits become trivial.
    let state = opts.initialState;
    this.render(await opts.render(state), opts.label);
    while (!(await opts.isDone(state))) {
      if (opts.tickMs !== undefined) {
        const tickPromise = new Promise<{ kind: "tick" }>((resolve) =>
          setTimeout(() => resolve({ kind: "tick" }), opts.tickMs),
        );
        const keyPromise = this.nextKey().then(
          (ev) => ({ kind: "key" as const, ev }),
        );
        const result = await Promise.race<
          { kind: "tick" } | { kind: "key"; ev: KeyEvent }
        >([keyPromise, tickPromise]);
        if (result.kind === "key") {
          state = await opts.handleKey(state, result.ev);
        }
      } else {
        const event = await this.nextKey();
        state = await opts.handleKey(state, event);
      }
      this.render(await opts.render(state), opts.label);
    }
    return state;
  }

  destroy(): void {
    this.input.destroy();
    if (this.output.destroy) this.output.destroy();
  }
}
