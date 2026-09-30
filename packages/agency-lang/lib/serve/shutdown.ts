import type http from "http";
import { exitProcess } from "../runtime/exitProcess.js";

/**
 * Make a served program shut down cleanly when it is told to stop. A server
 * does not wait for log uploads before it answers a request, so the logs of
 * the last few requests may still be on their way when a hosting platform
 * sends SIGTERM to restart the process. Node's default for that signal is to
 * die at once, which loses them.
 *
 * On SIGTERM or SIGINT this stops accepting connections, waits for the
 * pending log requests, and exits 0. Requests still running are cut off, as
 * they were before. `server` is absent for the stdio MCP server.
 */
export function exitOnShutdownSignal(server?: http.Server): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server?.close();
    void exitProcess(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
