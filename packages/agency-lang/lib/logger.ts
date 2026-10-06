import { currentRunOrNone } from "./runtime/asyncContext.js";

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

/** Where a log line goes when no run is current: the console, by level.
 *  `console.error` and `console.warn` write to standard error, the other
 *  two to standard output, as they always have. */
export function consoleLogSink(level: LogLevel, text: string): void {
  if (level === "error") {
    console.error(text);
  } else if (level === "warn") {
    console.warn(text);
  } else if (level === "debug") {
    console.debug(text);
  } else {
    console.info(text);
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVEL_ORDER[level];

  // A line goes to the host of the current run, when there is one, so an
  // app that embeds the runtime sees the runtime's warnings. With no run
  // current, which is also where the logger stands after a helper's first
  // `await`, the line goes to the console, which is where nodeHost sends
  // it too.
  function log(msgLevel: LogLevel, message: string): void {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    const formatted = `[${timestamp}] ${msgLevel.toUpperCase()} ${message}`;
    // run-read-ok: with no run current, the line goes to the console.
    const host = currentRunOrNone()?.ctx.host;
    if (host) {
      host.settings.log(msgLevel, formatted);
    } else {
      consoleLogSink(msgLevel, formatted);
    }
  }

  return {
    debug: (msg) => log("debug", msg),
    info: (msg) => log("info", msg),
    warn: (msg) => log("warn", msg),
    error: (msg) => log("error", msg),
  };
}
