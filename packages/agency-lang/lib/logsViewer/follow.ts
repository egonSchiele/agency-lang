import * as fs from "node:fs";

export type FollowOpts = {
  path: string;
  // Called whenever the file grew, with the newly-appended chunk only.
  // The chunk is the raw bytes from the prior offset to current size.
  onAppend: (chunk: string) => void;
  // Poll interval. Defaults to 250ms; tests inject 50ms.
  intervalMs?: number;
};

export type Follower = {
  stop(): void;
};

// Watch `path` for size growth and push the appended bytes into
// `onAppend`. We poll `stat().size` directly on a setInterval rather
// than using `fs.watchFile`, because watchFile is documented to
// fire only on observable stat changes — on filesystems with
// second-resolution mtime (common on Linux CI runners) an append
// that lands in the same second as the previous stat can be missed
// entirely. A plain size poll is dumber and more reliable.
//
// The first poll (matching the starting offset) doesn't emit
// anything; only growth from the starting offset onward is reported.
export function follow(opts: FollowOpts): Follower {
  const interval = opts.intervalMs ?? 250;
  let offset = safeSize(opts.path);
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    const size = safeSize(opts.path);
    if (size === offset) return;
    if (size < offset) {
      // File shrank (rotation / truncation): rewind to start and
      // emit everything from there on the next tick.
      offset = 0;
      return;
    }
    const fd = fs.openSync(opts.path, "r");
    try {
      const length = size - offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      offset = size;
      opts.onAppend(buf.toString("utf-8"));
    } finally {
      fs.closeSync(fd);
    }
  };

  const timer = setInterval(tick, interval);
  // Don't keep the event loop alive solely for the poller.
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function safeSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}
