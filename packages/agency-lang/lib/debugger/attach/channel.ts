// The smallest thing a message can cross between a running program and
// the debugger attached to it. A Unix socket is one implementation
// (`lineChannel.ts`); a test uses the in-memory pair below. Messages are
// plain JSON values; the protocol is `protocol.ts`.

export type Channel = {
  send(message: unknown): void;
  /** Hand every message to `listener` until the returned function is
   *  called. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Run `listener` once, when the channel closes for any reason. */
  onClose(listener: () => void): () => void;
  close(): void;
  /** Whether this channel keeps the process alive. The run side holds
   *  the channel while a program is stopped waiting for the debugger's
   *  answer, and nothing else may be keeping the process up; the rest of
   *  the time an open session must not keep a finished program alive. A
   *  channel with no process to keep alive ignores it. */
  keepAlive(on: boolean): void;
};

type Listeners = {
  message: ((message: unknown) => void)[];
  close: (() => void)[];
};

/** Two channels wired to each other: what one sends, the other receives,
 *  on a later turn of the event loop so a listener registered right after
 *  `send` still sees the message. Closing either closes both. */
export function memoryChannelPair(): [Channel, Channel] {
  const left: Listeners = { message: [], close: [] };
  const right: Listeners = { message: [], close: [] };
  let closed = false;
  const closeBoth = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const listener of [...left.close, ...right.close]) {
      listener();
    }
  };
  const make = (mine: Listeners, theirs: Listeners): Channel => ({
    send: (message) => {
      if (closed) {
        return;
      }
      queueMicrotask(() => {
        for (const listener of [...theirs.message]) {
          listener(message);
        }
      });
    },
    onMessage: (listener) => {
      mine.message.push(listener);
      return () => {
        mine.message = mine.message.filter((entry) => entry !== listener);
      };
    },
    onClose: (listener) => {
      mine.close.push(listener);
      return () => {
        mine.close = mine.close.filter((entry) => entry !== listener);
      };
    },
    close: closeBoth,
    keepAlive: () => {},
  });
  return [make(left, right), make(right, left)];
}
