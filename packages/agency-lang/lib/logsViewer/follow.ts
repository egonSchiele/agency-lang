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
// `onAppend`. We poll the file size on a fixed interval rather than
// using `fs.watchFile`, because `watchFile` only fires when its
// polled stat differs from the previously-observed stat, and on
// some platforms / filesystems (notably Linux CI) it can miss size
// changes that happen close to a poll boundary. Explicit polling
// is more deterministic. The initial file contents are NOT emitted —
// only growth from the starting offset onward.
export function follow(opts: FollowOpts): Follower {
  const interval = opts.intervalMs ?? 250;
  let offset = safeSize(opts.path);
  let stopped = false;

  const poll = (): void => {
    if (stopped) return;
    const size = safeSize(opts.path);
    if (size < offset) {
      // File shrank (rotation/truncation): rewind to start so the
      // next poll emits everything from there.
      offset = 0;
      return;
    }
    if (size === offset) return;
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

  const handle = setInterval(poll, interval);
  return {
    stop(): void {
      stopped = true;
      clearInterval(handle);
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
