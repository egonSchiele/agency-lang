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
    render: (state: S) => Element;
    handleKey: (state: S, event: KeyEvent) => S;
    isDone: (state: S) => boolean;
    label?: string;
  }): Promise<S> {
    let state = opts.initialState;
    this.render(opts.render(state), opts.label);
    while (!opts.isDone(state)) {
      const event = await this.nextKey();
      state = opts.handleKey(state, event);
      this.render(opts.render(state), opts.label);
    }
    return state;
  }

  destroy(): void {
    this.input.destroy();
    if (this.output.destroy) this.output.destroy();
  }
}
