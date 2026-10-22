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

  /** Adopt a new terminal size. Layout reads these on every render, so an app
   *  that watches SIGWINCH can keep panes correct without restarting. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  async runLoop<S>(opts: {
    initialState: S;
    render: (state: S) => Element | Promise<Element>;
    handleKey: (state: S, event: KeyEvent) => S | Promise<S>;
    isDone: (state: S) => boolean | Promise<boolean>;
    label?: string;
  }): Promise<S> {
    // The render / handleKey / isDone callbacks may be async. Pure-TS
    // callers can still pass sync functions; the awaits become trivial.
    let state = opts.initialState;
    this.render(await opts.render(state), opts.label);
    while (!(await opts.isDone(state))) {
      const event = await this.nextKey();
      state = await opts.handleKey(state, event);
      this.render(await opts.render(state), opts.label);
    }
    return state;
  }

  destroy(): void {
    this.input.destroy();
    if (this.output.destroy) this.output.destroy();
  }
}
