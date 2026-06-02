export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type Logger = {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVEL_ORDER[level];

  // Route through `console.*` rather than `process.stderr.write`.
  // Reason: when an `std::ui.repl()` is active it owns the alt-screen
  // and installs a console capture (`_installConsoleCapture` in
  // lib/stdlib/ui.ts) that funnels console output into the transcript
  // list. Raw `stderr.write` would bypass that, hit the terminal
  // directly, and tear the rendered frame — exactly the breakage seen
  // when a Wikipedia search failure raised a stack trace mid-REPL.
  // Outside a REPL, `console.error` still writes to stderr by
  // default, so headless behavior is unchanged.
  function log(msgLevel: LogLevel, message: string): void {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    const formatted = `[${timestamp}] ${msgLevel.toUpperCase()} ${message}`;
    if (msgLevel === "error") {
      console.error(formatted);
    } else if (msgLevel === "warn") {
      console.warn(formatted);
    } else if (msgLevel === "debug") {
      console.debug(formatted);
    } else {
      console.info(formatted);
    }
  }

  return {
    debug: (msg) => log("debug", msg),
    info: (msg) => log("info", msg),
    warn: (msg) => log("warn", msg),
    error: (msg) => log("error", msg),
  };
}
