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
// `onAppend`. We use `fs.watchFile` rather than `fs.watch` because
// watchFile works uniformly across platforms and gives us prev/curr
// stat objects, which is exactly what we need to compute the delta
// range. The first callback (when the file already exists) doesn't
// emit anything — only growth from the starting offset onward.
export function follow(opts: FollowOpts): Follower {
  const interval = opts.intervalMs ?? 250;
  let offset = safeSize(opts.path);
  let stopped = false;

  const listener = (curr: fs.Stats, prev: fs.Stats): void => {
    if (stopped) return;
    if (curr.size <= offset) {
      // File shrank (rotation/truncation): rewind to start and
      // emit everything from there next tick.
      if (curr.size < prev.size) offset = 0;
      return;
    }
    const fd = fs.openSync(opts.path, "r");
    try {
      const length = curr.size - offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      offset = curr.size;
      opts.onAppend(buf.toString("utf-8"));
    } finally {
      fs.closeSync(fd);
    }
  };

  fs.watchFile(opts.path, { interval }, listener);
  return {
    stop(): void {
      stopped = true;
      fs.unwatchFile(opts.path, listener);
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
