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
  // Tracks whether our SIGTSTP listener is currently installed. We
  // remove it during the suspend handoff and re-install it on resume,
  // and SIGCONT can be delivered independently of our SIGTSTP path
  // (e.g. from a foreign SIGSTOP), so the resume path must be idempotent.
  private sigtstpInstalled = false;
  private exitHandler = () => this.destroy();
  private sigintHandler = () => { this.destroy(); process.exit(130); };
  private sigtermHandler = () => { this.destroy(); process.exit(143); };
  private sigtstpHandler = () => {
    // Remove our handler before re-raising so the default handler can
    // actually suspend the process; otherwise we'd recurse into ourselves.
    this.suspend();
    if (this.sigtstpInstalled) {
      process.removeListener("SIGTSTP", this.sigtstpHandler);
      this.sigtstpInstalled = false;
    }
    process.kill(process.pid, "SIGTSTP");
  };
  private sigcontHandler = () => {
    this.resume();
    // Re-install only if we don't currently have it registered.
    if (!this.sigtstpInstalled) {
      process.on("SIGTSTP", this.sigtstpHandler);
      this.sigtstpInstalled = true;
    }
  };

  init(): void {
    process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    this.inAltScreen = true;
    process.on("exit", this.exitHandler);
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);
    process.on("SIGTSTP", this.sigtstpHandler);
    this.sigtstpInstalled = true;
    process.on("SIGCONT", this.sigcontHandler);
  }

  write(frame: Frame, _label?: string): void {
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
    this.sigtstpInstalled = false;
  }
}
