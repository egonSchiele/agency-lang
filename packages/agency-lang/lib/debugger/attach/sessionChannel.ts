// The adapter around `sessionRules.ts`: a `Channel` the driver's
// `ChannelDebuggerIO` speaks on, with the parties' channels behind it.
// Every message from the driver, every message from a party, every
// connection and close, and the lease timer firing becomes one event
// through `step`, and the effects that come back are applied here. This
// is the only file of the session with a timer in it; `server.ts` has the
// sockets.
import type { Channel } from "./channel.js";
import { parseAttachMessage, type ClientKind } from "./protocol.js";
import {
  emptySession,
  step,
  LEASE_MS,
  type Effect,
  type PartyId,
  type SessionEvent,
  type SessionState,
} from "./sessionRules.js";

export type SessionTimers = {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type SessionChannelOptions = {
  now?: () => number;
  /** The lease timer; a test injects a fake clock. The default is
   *  `setTimeout`, unreferenced, so a held session never keeps a
   *  finished program alive on its own. */
  timers?: SessionTimers;
  /** What the driver's `keepAlive` does: with no socket of its own to
   *  hold, the session refs the server while a request is pending. */
  keepAlive?: (on: boolean) => void;
  /** Where the lease's line goes; the program's stderr by default. */
  log?: (line: string) => void;
};

export type SessionChannel = Channel & {
  /** A connection that sent `client` with this kind. */
  admit(channel: Channel, kind: ClientKind): void;
  state(): SessionState;
  /** End the session: every party's channel is closed and the driver's
   *  side sees the channel close. */
  end(): void;
};

const defaultTimers: SessionTimers = {
  set: (fire, ms) => {
    const handle = setTimeout(fire, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function sessionChannel(options: SessionChannelOptions = {}): SessionChannel {
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? defaultTimers;
  const log = options.log ?? ((line: string) => console.error(line));
  let state = emptySession();
  let parties: Record<PartyId, Channel> = {};
  let nextParty = 1;
  let lease: unknown = null;
  let ended = false;
  let driverListeners: ((message: unknown) => void)[] = [];
  let closeListeners: (() => void)[] = [];

  const run = (effect: Effect): void => {
    switch (effect.type) {
      case "send":
        parties[effect.to]?.send(effect.message);
        return;
      case "close": {
        const party = parties[effect.party];
        delete parties[effect.party];
        party?.close();
        return;
      }
      case "toDriver":
        for (const listener of [...driverListeners]) {
          listener(effect.message);
        }
        return;
      case "startLease":
        timers.clear(lease);
        lease = timers.set(() => apply({ type: "leaseExpired" }), LEASE_MS);
        return;
      case "clearLease":
        timers.clear(lease);
        lease = null;
        return;
      case "log":
        log(effect.line);
        return;
      case "end":
        end();
        return;
    }
  };

  const apply = (event: SessionEvent): void => {
    if (ended) {
      return;
    }
    const stepped = step(state, event);
    state = stepped.state;
    for (const effect of stepped.effects) {
      run(effect);
    }
  };

  const end = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    timers.clear(lease);
    const open = Object.values(parties);
    parties = {};
    for (const party of open) {
      party.close();
    }
    for (const listener of closeListeners) {
      listener();
    }
  };

  return {
    send: (message) => {
      const parsed = parseAttachMessage(message);
      if (parsed !== null) {
        apply({ type: "fromDriver", message: parsed });
      }
    },
    onMessage: (listener) => {
      driverListeners.push(listener);
      return () => {
        driverListeners = driverListeners.filter((entry) => entry !== listener);
      };
    },
    onClose: (listener) => {
      closeListeners.push(listener);
      return () => {
        closeListeners = closeListeners.filter((entry) => entry !== listener);
      };
    },
    close: end,
    keepAlive: (on) => options.keepAlive?.(on),
    admit: (channel, kind) => {
      if (ended) {
        channel.send({ type: "refused", reason: "the session has ended" });
        channel.close();
        return;
      }
      const party = nextParty++;
      parties[party] = channel;
      channel.onMessage((raw) => {
        const message = parseAttachMessage(raw);
        if (message !== null) {
          apply({ type: "fromParty", party, message });
        }
      });
      channel.onClose(() => {
        delete parties[party];
        apply({ type: "disconnect", party, now: now() });
      });
      apply({ type: "connect", party, kind, now: now() });
    },
    state: () => state,
    end,
  };
}
