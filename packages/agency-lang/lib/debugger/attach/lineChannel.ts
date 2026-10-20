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

/** How long `close` waits for the peer to take the last message before
 *  the socket is destroyed anyway. */
const CLOSE_FLUSH_MS = 2000;

export function lineChannel(socket: net.Socket, maxBytes: number = MAX_MESSAGE_BYTES): Channel {
  // The pieces of the line in progress, joined only when its newline
  // arrives. A large message comes in many chunks, and joining or
  // scanning the whole buffer on every chunk made receiving quadratic in
  // the message's size: 60 MiB took half a minute.
  let pieces: string[] = [];
  let pendingBytes = 0;
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

  const overCap = (bytes: number, direction: "sent" | "received"): void => {
    console.error(
      `[agency debug] a debugger message of ${bytes} bytes was ${direction}, over the ` +
        `${maxBytes} one message can carry; closing the session`,
    );
    socket.destroy(new Error(`a debugger message went over ${maxBytes} bytes`));
  };

  const deliver = (line: string): boolean => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      socket.destroy(new Error("a debugger message was not JSON"));
      return false;
    }
    for (const listener of [...messageListeners]) {
      listener(message);
    }
    return true;
  };

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let rest = chunk;
    while (!socket.destroyed) {
      const newline = rest.indexOf("\n");
      if (newline === -1) {
        pendingBytes += Buffer.byteLength(rest);
        if (pendingBytes > maxBytes) {
          overCap(pendingBytes, "received");
          return;
        }
        pieces.push(rest);
        return;
      }
      const line = pieces.join("") + rest.slice(0, newline);
      pieces = [];
      pendingBytes = 0;
      rest = rest.slice(newline + 1);
      const bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) {
        overCap(bytes, "received");
        return;
      }
      if (!deliver(line)) {
        return;
      }
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
      const bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) {
        overCap(bytes, "sent");
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
    // `end` queues the close behind what is still being written, so the
    // last message (`finished` with a large return value) reaches the
    // peer; `destroy` right after `end` threw it away. The socket is
    // destroyed once the writes have gone out, or after a short wait for
    // a peer that never reads. The listeners hear the close at once.
    close: () => {
      if (!socket.destroyed) {
        const fallback = setTimeout(() => socket.destroy(), CLOSE_FLUSH_MS);
        fallback.unref();
        socket.once("finish", () => {
          clearTimeout(fallback);
          socket.destroy();
        });
        socket.end();
      }
      closeOnce();
    },
    keepAlive: (on) => {
      if (on) {
        socket.ref();
      } else {
        socket.unref();
      }
    },
  };
}
