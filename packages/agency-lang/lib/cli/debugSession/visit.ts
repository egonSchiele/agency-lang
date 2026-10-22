// One visit of `agency debug session`: a connection to a running
// program's debug socket as a `cli` party. It is `serveDebuggerIO` turned
// inside out: instead of answering each request with a UI call, it
// collects what the run sends on joining (hello, who is on the run, the
// recent activity, the stop, the request waiting for an answer), hands
// that to a command, and sends the one reply the command decides on. A
// render is acknowledged as it arrives, as a UI would. The only file on
// the CLI side with protocol logic in it; `index.ts` has the socket.
import { checkpointFromWire } from "@/debugger/attach/serveIO.js";
import type { Channel } from "@/debugger/attach/channel.js";
import {
  parseAttachMessage,
  type AnsweredMessage,
  type AttachMessage,
  type FinishedMessage,
  type Hello,
  type PartiesMessage,
  type RequestMessage,
  type StatusMessage,
} from "@/debugger/attach/protocol.js";
import type { Checkpoint } from "@/runtime/state/checkpointStore.js";
import type { DebugStopData } from "@/runtime/debugger.js";
import type { PendingPreview } from "@/debugger/edits/rows.js";

/** The stop as the run last drew it. */
export type Shown = {
  checkpoint: Checkpoint | undefined;
  stop: DebugStopData | undefined;
  interruptId: string | undefined;
};

/** What a visit knows once it has joined. */
export type Joined = {
  hello: Hello;
  parties: PartiesMessage;
  /** The activity lines the run kept since the last visit. */
  recent: string[];
  shown: Shown | null;
  /** The request waiting for an answer, or null while the program runs. */
  pending: RequestMessage | null;
  /** Set when the program had ended before this visit. */
  finished: FinishedMessage | null;
  /** The edits queued at the stop, as the run last said; read live, so
   *  the `where` a verb prints after queuing one shows it. */
  queuedEdits: PendingPreview;
};

/** What comes after a reply, or after waiting: the next request (with
 *  the render that came before it, when one did), a refusal because
 *  another party answered first, the program's end, the channel closing,
 *  or the deadline. */
export type Next =
  | { kind: "request"; request: RequestMessage; shown: Shown | null; recent: string[] }
  | { kind: "answered"; answered: AnsweredMessage }
  | { kind: "finished"; finished: FinishedMessage }
  | { kind: "closed" }
  | { kind: "timeout" };

export type Visit = Joined & {
  /** Send `result` as the reply to `pending`, then wait for what comes
   *  next, up to `timeoutMs`. */
  answer(result: unknown, timeoutMs: number): Promise<Next>;
  /** Reply to a later request (a panel the driver asked for after a
   *  command), then wait as `answer` does. */
  reply(id: number, result: unknown, timeoutMs: number): Promise<Next>;
  /** Wait for the next request without answering anything: `wait` on a
   *  running program. */
  next(timeoutMs: number): Promise<Next>;
  /** Ask a running program to stop at its next statement. */
  pause(): void;
  /** Release the CLI's hold on the session and close. */
  detach(): void;
  close(): void;
};

/** How long after joining to wait for a request before deciding the
 *  program is running. The run sends the stop and the pending request
 *  right after `parties`, so a short grace is enough; a visit on a
 *  stopped program sees its request well inside it. */
export const JOIN_GRACE_MS = 300;

export type VisitRefusal = { refused: string };

/** Join the session on `channel` as a CLI visit. Resolves once the run
 *  has said who is on it and either sent the pending request or gone
 *  quiet for the grace period; rejects with the run's refusal. */
export function openVisit(
  channel: Channel,
  graceMs: number = JOIN_GRACE_MS,
): Promise<Visit | VisitRefusal> {
  const inbox = new Inbox(channel);
  channel.send({ type: "client", kind: "cli" });
  return inbox.join(graceMs);
}

/** Send `client probe` on `channel` and return the run's `status`. */
export function probeStatus(channel: Channel, timeoutMs: number): Promise<StatusMessage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      channel.close();
      resolve(null);
    }, timeoutMs);
    channel.onMessage((raw) => {
      const message = parseAttachMessage(raw);
      if (message?.type === "status") {
        clearTimeout(timer);
        // Resolved before the close: closing fires the close listener
        // below at once, and a promise keeps its first value.
        resolve(message);
        channel.close();
      }
    });
    channel.onClose(() => {
      clearTimeout(timer);
      resolve(null);
    });
    channel.send({ type: "client", kind: "probe" });
  });
}

/** The messages a visit has received and not yet consumed, with a way
 *  to wait for the next one. Renders are acknowledged as they arrive and
 *  kept as `shown`; log notices are kept as `recent`. */
class Inbox {
  private queue: AttachMessage[] = [];
  private waiter: ((message: AttachMessage | null) => void) | null = null;
  private closed = false;
  shown: Shown | null = null;
  recent: string[] = [];
  queuedEdits: PendingPreview = { edits: [], applied: [] };

  constructor(private readonly channel: Channel) {
    channel.onMessage((raw) => {
      const message = parseAttachMessage(raw);
      if (message === null) {
        return;
      }
      if (message.type === "request" && message.method === "render") {
        // A render without a checkpoint is the same stop redrawn (the
        // driver sends one after `set` and `checkpoint`): what was shown
        // stays, as the terminal keeps its checkpoint for such a redraw.
        const checkpoint =
          message.args[0] == null ? this.shown?.checkpoint : checkpointFromWire(message.args[0]);
        this.shown = {
          checkpoint,
          stop: (message.args[1] as DebugStopData | undefined) ?? this.shown?.stop,
          interruptId: message.args[2] as string | undefined,
        };
        channel.send({ type: "reply", id: message.id, result: undefined });
        return;
      }
      if (message.type === "notice") {
        if (message.method === "log") {
          this.recent.push(String(message.args[0]));
        }
        if (message.method === "setPending") {
          this.queuedEdits = message.args[0] as PendingPreview;
        }
        return;
      }
      this.deliver(message);
    });
    channel.onClose(() => {
      this.closed = true;
      this.deliver(null);
    });
  }

  private deliver(message: AttachMessage | null): void {
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter(message);
      return;
    }
    if (message !== null) {
      this.queue.push(message);
    }
  }

  /** The next message, null when the channel closed, undefined at the
   *  deadline. What has already arrived is taken whatever the deadline,
   *  so a zero wait still sees a refusal that came with the reply. */
  private take(timeoutMs: number): Promise<AttachMessage | null | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    if (timeoutMs <= 0) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter === settle) {
          this.waiter = null;
        }
        resolve(undefined);
      }, timeoutMs);
      const settle = (message: AttachMessage | null): void => {
        clearTimeout(timer);
        resolve(message);
      };
      this.waiter = settle;
    });
  }

  async join(graceMs: number): Promise<Visit | VisitRefusal> {
    let hello: Hello | null = null;
    let parties: PartiesMessage | null = null;
    while (parties === null) {
      const message = await this.take(graceMs * 10);
      if (message === null || message === undefined) {
        return { refused: "the program closed the connection before saying who is on it" };
      }
      if (message.type === "refused") {
        return { refused: message.reason };
      }
      if (message.type === "finished") {
        return this.visit(hello, { type: "parties", terminal: false, cli: true }, null, message);
      }
      if (message.type === "hello") {
        hello = message;
      }
      if (message.type === "parties") {
        parties = message;
      }
    }
    // The stop and the pending request follow at once when the program
    // is stopped; nothing follows when it is running. The activity lines
    // `next` hands over with the request are the ones since the last
    // visit, and belong to this one.
    const after = await this.next(graceMs);
    if (after.kind === "request") {
      this.recent = [...after.recent, ...this.recent];
      return this.visit(hello, parties, after.request, null);
    }
    if (after.kind === "finished") {
      return this.visit(hello, parties, null, after.finished);
    }
    return this.visit(hello, parties, null, null);
  }

  private visit(
    hello: Hello | null,
    parties: PartiesMessage,
    pending: RequestMessage | null,
    finished: FinishedMessage | null,
  ): Visit | VisitRefusal {
    if (hello === null) {
      return {
        refused: "the program said who is on it before saying hello; is it an older build?",
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getter below reads the inbox's latest
    const inbox = this;
    return {
      hello,
      parties,
      recent: this.recent,
      shown: this.shown,
      pending,
      finished,
      get queuedEdits() {
        return inbox.queuedEdits;
      },
      answer: (result, timeoutMs) => {
        if (pending === null) {
          return Promise.resolve({ kind: "timeout" });
        }
        this.channel.send({ type: "reply", id: pending.id, result });
        return this.next(timeoutMs);
      },
      reply: (id, result, timeoutMs) => {
        this.channel.send({ type: "reply", id, result });
        return this.next(timeoutMs);
      },
      next: (timeoutMs) => this.next(timeoutMs),
      pause: () => this.channel.send({ type: "pause" }),
      detach: () => {
        this.channel.send({ type: "detach" });
        this.channel.close();
      },
      close: () => this.channel.close(),
    };
  }

  /** The next thing that matters: a request other than a render, an
   *  `answered`, the end, a close, or the deadline. */
  async next(timeoutMs: number): Promise<Next> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const message = await this.take(Math.max(0, deadline - Date.now()));
      if (message === undefined) {
        return { kind: "timeout" };
      }
      if (message === null) {
        return { kind: "closed" };
      }
      if (message.type === "request") {
        const recent = this.recent;
        this.recent = [];
        return { kind: "request", request: message, shown: this.shown, recent };
      }
      if (message.type === "answered") {
        return { kind: "answered", answered: message };
      }
      if (message.type === "finished") {
        return { kind: "finished", finished: message };
      }
    }
  }
}
