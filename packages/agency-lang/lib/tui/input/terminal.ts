import * as readline from "node:readline";
import type { KeyEvent, InputSource } from "./types.js";

const KEY_MAP: Record<string, KeyEvent> = {
  // Special keys
  "\x1b": { key: "escape" },
  // Plain Enter submits. `\n` (LF) and `\x1b\r` / `\x1b\n` (Alt/Option+
  // Enter, "Meta+Enter") are treated as Shift+Enter so users on
  // terminals that don't transmit a distinct Shift+Enter code can
  // still insert a newline. Alt+Enter is the most portable fallback —
  // both Terminal.app and iTerm2 deliver it as `\x1b\r` out of the
  // box; users who configure their terminal to send `\n` for
  // Shift+Enter (iTerm2's "Report modifiers using CSI u" or similar)
  // get the same behavior automatically.
  "\r": { key: "enter" },
  "\n": { key: "enter", shift: true },
  "\x1b\r": { key: "enter", shift: true },
  "\x1b\n": { key: "enter", shift: true },
  "\x7f": { key: "backspace" },
  "\t": { key: "tab" },
  // Arrow keys (CSI)
  "\x1b[A": { key: "up" },
  "\x1b[B": { key: "down" },
  "\x1b[C": { key: "right" },
  "\x1b[D": { key: "left" },
  // Arrow keys (SS3)
  "\x1bOA": { key: "up" },
  "\x1bOB": { key: "down" },
  "\x1bOC": { key: "right" },
  "\x1bOD": { key: "left" },
  // Navigation
  "\x1b[H": { key: "home" },
  "\x1b[F": { key: "end" },
  "\x1bOH": { key: "home" },
  "\x1bOF": { key: "end" },
  "\x1b[5~": { key: "pageup" },
  "\x1b[6~": { key: "pagedown" },
  "\x1b[3~": { key: "delete" },
  "\x1b[2~": { key: "insert" },
  // Shift+arrow
  "\x1b[1;2A": { key: "up", shift: true },
  "\x1b[1;2B": { key: "down", shift: true },
  "\x1b[1;2C": { key: "right", shift: true },
  "\x1b[1;2D": { key: "left", shift: true },
  // Shift+Tab (CSI Z) — used for reverse focus cycling
  "\x1b[Z": { key: "tab", shift: true },
};

// Sentinel used to wake up nextKey() waiters with a rejection when the
// terminal is being handed over to readline for nextLine().
const LINE_MODE_CANCEL: KeyEvent = { key: "__line_mode_cancel__" };

// Bracketed paste markers. When enabled with `\x1b[?2004h`, terminals
// emit `PASTE_START ... PASTE_END` around any text the user pastes
// (e.g. Cmd+V on macOS). We parse those out into a single synthetic
// `{ key: "paste", text }` event so the reducer can append the whole
// payload atomically instead of seeing one keystroke per character
// (which would, among other things, treat embedded newlines as Enter
// and prematurely submit the prompt).
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// Escape sequences from KEY_MAP, longest first — `readEscapeSequence`
// does a longest-prefix match so `\x1b[1;2A` (Shift+Up) wins over the
// shorter `\x1b[` prefix used by plain Up.
const ESCAPE_SEQUENCES = Object.keys(KEY_MAP)
  .filter((seq) => seq.startsWith("\x1b") && seq.length > 1)
  .sort((a, b) => b.length - a.length);

export function parseKeypress(data: string): KeyEvent {
  const mapped = KEY_MAP[data];
  if (mapped) return mapped;

  // Ctrl+letter (0x01-0x1a)
  const code = data.charCodeAt(0);
  if (data.length === 1 && code >= 1 && code <= 26) {
    return { key: String.fromCharCode(code + 96), ctrl: true };
  }

  return { key: data };
}

/**
 * Try to read text bracketed by `open ... close` markers starting at
 * `pos` in `str`. Three outcomes:
 *
 *  - `null`            — `str` doesn't begin the `open` marker at `pos`.
 *  - `{ kind: "partial", body }` — the `open` marker was found but
 *    `close` hasn't arrived yet. Caller should buffer `body` and
 *    re-attempt with the next chunk prepended (or simply stash it
 *    until the close marker turns up).
 *  - `{ kind: "complete", body, end }` — both markers found. `body`
 *    is the text between them; `end` is the index in `str` just past
 *    `close`, ready to resume scanning from.
 *
 * Used for bracketed-paste payloads (`\x1b[200~ ... \x1b[201~`) but
 * deliberately marker-agnostic — any future `open/close` framing can
 * reuse this.
 */
type BracketedRead =
  | null
  | { kind: "partial"; body: string }
  | { kind: "complete"; body: string; end: number };

export function readBracketed(
  str: string,
  pos: number,
  open: string,
  close: string,
): BracketedRead {
  if (!str.startsWith(open, pos)) return null;
  const bodyStart = pos + open.length;
  const closeIdx = str.indexOf(close, bodyStart);
  if (closeIdx === -1) {
    return { kind: "partial", body: str.slice(bodyStart) };
  }
  return {
    kind: "complete",
    body: str.slice(bodyStart, closeIdx),
    end: closeIdx + close.length,
  };
}

/**
 * Longest-prefix match against the known escape-sequence table at
 * `pos`. Returns the mapped `KeyEvent` plus the byte count consumed,
 * or `null` if either `str[pos] !== ESC` or no entry matches.
 */
export function readEscapeSequence(
  str: string,
  pos: number,
): { event: KeyEvent; consumed: number } | null {
  if (str[pos] !== "\x1b") return null;
  for (const seq of ESCAPE_SEQUENCES) {
    if (str.startsWith(seq, pos)) {
      return { event: KEY_MAP[seq], consumed: seq.length };
    }
  }
  return null;
}

export class TerminalInput implements InputSource {
  private keyWaiters: ((key: KeyEvent) => void)[] = [];
  private keyQueue: KeyEvent[] = [];
  private dataHandler: ((data: Buffer) => void) | null = null;
  private sigcontHandler: (() => void) | null = null;
  private wasRaw = false;
  private initialized = false;
  private inLineMode = false;
  private suspended = false;
  // Accumulator for a bracketed paste that spans multiple `data`
  // events. `null` when no paste is in progress; a string buffer
  // collecting the body once `PASTE_START` has been seen.
  private pasteBuffer: string | null = null;

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.init();
  }

  init(): void {
    if (!process.stdin.isTTY) {
      throw new Error("TerminalInput requires a TTY stdin");
    }

    this.wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // Enable bracketed paste mode. The terminal will now wrap any
    // pasted text in `\x1b[200~ ... \x1b[201~` markers, letting us
    // distinguish a paste from rapid typing. Modern terminals
    // (Terminal.app, iTerm2, Alacritty, kitty, VS Code, WezTerm) all
    // honor this; older / dumb terminals silently ignore it.
    process.stdout.write("\x1b[?2004h");

    this.dataHandler = (data: Buffer) => {
      this.parseAndEmit(data.toString("utf-8"));
    };

    process.stdin.on("data", this.dataHandler);

    // SIGCONT can be delivered after our Ctrl+Z handoff or after a foreign
    // SIGSTOP; either way we need to put stdin back into raw mode.
    this.sigcontHandler = () => this.resumeFromSuspend();
    process.on("SIGCONT", this.sigcontHandler);
  }

  // Called when 0x1a arrives in raw mode. Suspend our own stdin handling,
  // then re-raise SIGTSTP to the process so the OS (and TerminalOutput's
  // SIGTSTP handler) can suspend us cleanly.
  private handleSuspendKeypress(): void {
    this.suspendForSigtstp();
    process.kill(process.pid, "SIGTSTP");
  }

  private suspendForSigtstp(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
    }
    if (process.stdin.isTTY && process.stdin.isRaw) {
      // Turn off bracketed paste before handing control back to the
      // shell, then turn it on again on resume. Otherwise the parent
      // shell sees pastes wrapped in `\x1b[200~...` literals.
      process.stdout.write("\x1b[?2004l");
      process.stdin.setRawMode(false);
    }
  }

  private resumeFromSuspend(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.inLineMode) return; // readline owns stdin; don't re-grab it
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdout.write("\x1b[?2004h");
      process.stdin.resume();
    }
    if (this.dataHandler) {
      process.stdin.on("data", this.dataHandler);
    }
  }

  nextKey(): Promise<KeyEvent> {
    this.ensureInitialized();
    const queued = this.keyQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      this.keyWaiters.push((key) => {
        if (key === LINE_MODE_CANCEL) {
          reject(new Error("nextKey() cancelled by nextLine()"));
        } else {
          resolve(key);
        }
      });
    });
  }

  /**
   * Synchronously deliver a synthetic key, exactly as if the user had
   * pressed it. If a `nextKey()` waiter is registered, the key resolves
   * that waiter; otherwise it queues. Mirrors `ScriptedInput.feedKey`
   * so cross-input code (notably the std::ui bridge's `_triggerRender`)
   * can poke a running event loop without knowing which input source
   * is installed.
   */
  feedKey(key: KeyEvent): void {
    this.emitKey(key);
  }

  /**
   * Internal: route a parsed `KeyEvent` to the next waiter or queue.
   * Shared by `feedKey` and the per-keystroke emissions in
   * `parseAndEmit`.
   */
  private emitKey(key: KeyEvent): void {
    const waiter = this.keyWaiters.shift();
    if (waiter) {
      waiter(key);
    } else {
      this.keyQueue.push(key);
    }
  }

  /**
   * Parse one stdin chunk into zero or more `KeyEvent`s and emit
   * them in order. Owns the side-band state machine across chunks:
   * an unfinished bracketed paste is parked in `this.pasteBuffer`
   * and resumed on the next call.
   *
   * Recognized units, tried in this order at each position:
   *   1. Continuation of a paste opened by a prior chunk
   *   2. A complete bracketed paste (`PASTE_START ... PASTE_END`)
   *   3. Ctrl+Z (0x1a) — raises SIGTSTP and stops parsing
   *   4. Ctrl+C (0x03) — raises SIGINT, emits, keeps parsing
   *   5. A known escape sequence (longest-prefix match)
   *   6. A single character (printable or ctrl+letter)
   */
  private parseAndEmit(input: string): void {
    let str = input;

    // 1. Mid-paste continuation. Treat the carried `pasteBuffer` as
    //    text already inside the markers, and look for the close
    //    marker anywhere in the current chunk.
    if (this.pasteBuffer !== null) {
      const closeIdx = str.indexOf(PASTE_END);
      if (closeIdx === -1) {
        this.pasteBuffer += str;
        return;
      }
      this.emitKey({
        key: "paste",
        text: this.pasteBuffer + str.slice(0, closeIdx),
      });
      this.pasteBuffer = null;
      str = str.slice(closeIdx + PASTE_END.length);
    }

    let i = 0;
    while (i < str.length) {
      // 2. Bracketed paste — start marker at this position.
      const paste = readBracketed(str, i, PASTE_START, PASTE_END);
      if (paste !== null) {
        if (paste.kind === "partial") {
          this.pasteBuffer = paste.body;
          return;
        }
        this.emitKey({ key: "paste", text: paste.body });
        i = paste.end;
        continue;
      }

      // 3. Ctrl+Z: surface as SIGTSTP and stop processing — the
      //    rest of this chunk is irrelevant once we're suspended.
      const code = str.charCodeAt(i);
      if (code === 0x1a) {
        this.handleSuspendKeypress();
        return;
      }

      // 4. Ctrl+C: re-raise SIGINT and ALSO emit the key so Agency
      //    handlers can react before the signal actually lands.
      if (code === 0x03) {
        process.kill(process.pid, "SIGINT");
        this.emitKey({ key: "c", ctrl: true });
        i += 1;
        continue;
      }

      // 5. Known escape sequence at this position.
      const esc = readEscapeSequence(str, i);
      if (esc !== null) {
        this.emitKey(esc.event);
        i += esc.consumed;
        continue;
      }

      // 6a. Bare ESC (no recognized CSI/SS3 follow-up).
      if (str[i] === "\x1b") {
        this.emitKey({ key: "escape" });
        i += 1;
        continue;
      }

      // 6b. Plain character. UTF-16 code unit — surrogate pairs
      //    emit as a 2-char key, which is fine for an input bar
      //    that just appends to a string.
      this.emitKey(parseKeypress(str[i]));
      i += 1;
    }
  }

  nextLine(prompt: string): Promise<string> {
    if (this.inLineMode) {
      return Promise.reject(new Error("nextLine() already in progress"));
    }
    this.inLineMode = true;
    // Cancel any pending nextKey() waiters: readline is about to take over
    // stdin, so they will never receive a keypress through our data handler.
    for (const waiter of this.keyWaiters) {
      waiter(LINE_MODE_CANCEL);
    }
    this.keyWaiters = [];
    // Drop any half-finished bracketed paste: readline owns stdin now,
    // so the matching `\x1b[201~` will never reach our parser. Without
    // this reset the next nextKey() session would prepend the stale
    // paste body to whatever the user types or pastes next.
    this.pasteBuffer = null;
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
    }

    // Created per-call because readline takes ownership of stdin and
    // must be closed before we can re-enter raw mode for key input.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        this.inLineMode = false;
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
        }
        if (this.dataHandler) {
          process.stdin.on("data", this.dataHandler);
        }
        resolve(answer);
      });
    });
  }

  destroy(): void {
    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
      this.dataHandler = null;
    }
    if (this.sigcontHandler) {
      process.removeListener("SIGCONT", this.sigcontHandler);
      this.sigcontHandler = null;
    }
    if (process.stdin.isTTY) {
      // Disable bracketed paste before restoring raw mode so the
      // following shell doesn't keep receiving `\x1b[200~`-wrapped
      // pastes after we exit.
      process.stdout.write("\x1b[?2004l");
      process.stdin.setRawMode(this.wasRaw);
    }
    process.stdin.pause();
    this.keyQueue = [];
    this.keyWaiters = [];
    this.pasteBuffer = null;
    this.suspended = false;
    this.initialized = false;
  }
}
