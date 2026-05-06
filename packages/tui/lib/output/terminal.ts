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
  private sigintHandler = () => { this.destroy(); process.exit(130); };
  private sigtermHandler = () => { this.destroy(); process.exit(143); };
  private sigtstpHandler = () => {
    this.suspend();
    process.kill(process.pid, "SIGTSTP");
  };
  private sigcontHandler = () => {
    this.resume();
  };

  init(): void {
    process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    this.inAltScreen = true;
    process.on("exit", this.exitHandler);
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);
    // For SIGTSTP, we need to remove the handler before re-raising so the
    // default handler can actually suspend the process.
    process.on("SIGTSTP", this.sigtstpHandler);
    process.on("SIGCONT", this.sigcontHandler);
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
    this.removeSignalHandlers();
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

  private removeSignalHandlers(): void {
    process.removeListener("exit", this.exitHandler);
    process.removeListener("SIGINT", this.sigintHandler);
    process.removeListener("SIGTERM", this.sigtermHandler);
    process.removeListener("SIGTSTP", this.sigtstpHandler);
    process.removeListener("SIGCONT", this.sigcontHandler);
  }
}
