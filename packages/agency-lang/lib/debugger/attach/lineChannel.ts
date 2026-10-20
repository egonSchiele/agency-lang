// A `Channel` over a Node socket: newline-delimited JSON, one message per
// line, with a cap per message. Written here and not lifted from the logs
// viewer's session code, whose framing is one request per connection with
// a small cap and a timeout; this is one long-lived two-way connection,
// and a checkpoint of an agent forty minutes in holds its message
// threads. Not reachable from the browser bundle: only the attach server
// and the CLI import it.
import type * as net from "net";

import type { Channel } from "./channel.js";

/** A message larger than this is not a checkpoint anyone can show; the
 *  connection is closed rather than buffered without end. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function lineChannel(socket: net.Socket, maxBytes: number = MAX_MESSAGE_BYTES): Channel {
  let buffer = "";
  let messageListeners: ((message: unknown) => void)[] = [];
  let closeListeners: (() => void)[] = [];
  let closed = false;

  const closeOnce = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    const listeners = closeListeners;
    closeListeners = [];
    for (const listener of listeners) {
      listener();
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > maxBytes) {
      socket.destroy(new Error(`a debugger message went over ${maxBytes} bytes`));
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy(new Error("a debugger message was not JSON"));
        return;
      }
      for (const listener of [...messageListeners]) {
        listener(message);
      }
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("error", () => closeOnce());
  socket.on("close", () => closeOnce());

  return {
    send: (message) => {
      if (closed || socket.destroyed) {
        return;
      }
      const line = JSON.stringify(message) + "\n";
      if (Buffer.byteLength(line) > maxBytes) {
        socket.destroy(new Error(`a debugger message went over ${maxBytes} bytes`));
        return;
      }
      socket.write(line);
    },
    onMessage: (listener) => {
      messageListeners.push(listener);
      return () => {
        messageListeners = messageListeners.filter((entry) => entry !== listener);
      };
    },
    onClose: (listener) => {
      closeListeners.push(listener);
      return () => {
        closeListeners = closeListeners.filter((entry) => entry !== listener);
      };
    },
    close: () => {
      socket.end();
      socket.destroy();
      closeOnce();
    },
  };
}
