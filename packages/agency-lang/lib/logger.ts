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

/** Where a logger writes: the `settings` part of a host. */
export type LogSink = { log(level: LogLevel, text: string): void };

/**
 * A logger whose lines go to `sink`, the settings part of the run's host,
 * so an app that embeds the runtime sees the runtime's warnings. A caller
 * that has the run passes `run.ctx.host.settings`. Without a sink, each
 * line goes to the host of the current run when there is one, and to the
 * console otherwise, which is also where the logger stands after a
 * helper's first `await`; nodeHost sends lines to the console too, so
 * on Node the two are the same.
 */
export function createLogger(level: LogLevel = "info", sink?: LogSink): Logger {
  const threshold = LEVEL_ORDER[level];

  function log(msgLevel: LogLevel, message: string): void {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    const formatted = `[${timestamp}] ${msgLevel.toUpperCase()} ${message}`;
    // run-read-ok: with no sink and no run current, the line goes to the console.
    const target = sink ?? currentRunOrNone()?.ctx.host.settings;
    if (target) {
      target.log(msgLevel, formatted);
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
