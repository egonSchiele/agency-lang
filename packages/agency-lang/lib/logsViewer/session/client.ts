// The CLI's side of the wire: connect to a viewer's socket, send one
// request, read one reply. Choosing WHICH viewer is the CLI target's job
// (`lib/cli/logsSession/target.ts`), not this file's.
import * as net from "net";

import { SESSION_TIMEOUT_MS, type SessionReply, type SessionRequest } from "./protocol.js";

export function request(
  socketPath: string,
  req: SessionRequest,
  timeoutMs: number = SESSION_TIMEOUT_MS,
): Promise<SessionReply> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = net.connect(socketPath);
    const finish = (outcome: { reply: SessionReply } | { error: Error }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if ("reply" in outcome) {
        resolve(outcome.reply);
      } else {
        reject(outcome.error);
      }
    };
    const timer = setTimeout(
      () => finish({ error: new Error(`no reply from ${socketPath} within ${timeoutMs}ms`) }),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify(req) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        finish({ reply: JSON.parse(buffer.slice(0, newline)) as SessionReply });
      } catch (error) {
        finish({ error: error as Error });
      }
    });
    socket.on("error", (error) => finish({ error }));
    socket.on("close", () => finish({ error: new Error(`${socketPath} closed without a reply`) }));
  });
}
