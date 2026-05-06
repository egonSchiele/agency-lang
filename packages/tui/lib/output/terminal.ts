import type { Frame } from "../frame.js";
import type { OutputTarget } from "./types.js";
import { toANSI } from "../render/ansi.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";

export class TerminalOutput implements OutputTarget {
  private inAltScreen = false;
  private exitHandler = () => this.destroy();

  init(): void {
    process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    this.inAltScreen = true;
    process.on("exit", this.exitHandler);
  }

  write(frame: Frame): void {
    if (!this.inAltScreen) {
      this.init();
    }
    const ansi = toANSI(frame);
    process.stdout.write(CURSOR_HOME + ansi);
  }

  destroy(): void {
    if (this.inAltScreen) {
      process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      this.inAltScreen = false;
    }
    process.removeListener("exit", this.exitHandler);
  }

  suspend(): void {
    if (this.inAltScreen) {
      process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      this.inAltScreen = false;
    }
  }

  resume(): void {
    if (!this.inAltScreen) {
      process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
      this.inAltScreen = true;
    }
  }
}
