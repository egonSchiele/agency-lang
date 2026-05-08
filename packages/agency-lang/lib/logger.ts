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

  function log(msgLevel: LogLevel, message: string): void {
    if (LEVEL_ORDER[msgLevel] < threshold) return;
    const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    process.stderr.write(`[${timestamp}] ${msgLevel.toUpperCase()} ${message}\n`);
  }

  return {
    debug: (msg) => log("debug", msg),
    info: (msg) => log("info", msg),
    warn: (msg) => log("warn", msg),
    error: (msg) => log("error", msg),
  };
}
