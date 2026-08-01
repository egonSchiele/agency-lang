import { currentFileSize, makeAppendReader } from "../statelog/appendReader.js";

export type FollowOpts = {
  path: string;
  // Called whenever the file grew, with the newly-appended chunk only.
  onAppend: (chunk: string) => void;
  // Poll interval. Defaults to 250ms; tests inject 50ms.
  intervalMs?: number;
};

export type Follower = {
  stop(): void;
};

// Watch `path` for growth and push appended text into `onAppend`. Polling,
// not `fs.watchFile`: watchFile only fires when its polled stat differs
// from the previously-observed one, and on some platforms (notably Linux
// CI) it can miss size changes near a poll boundary. The initial file
// contents are NOT emitted — only growth from the starting offset onward.
// The mid-write hazards (split UTF-8 characters, short reads, truncation)
// are the append reader's job.
export function follow(opts: FollowOpts): Follower {
  const reader = makeAppendReader(opts.path, currentFileSize(opts.path));
  const handle = setInterval(() => {
    const chunk = reader.read();
    if (chunk.length > 0) {
      opts.onAppend(chunk);
    }
  }, opts.intervalMs ?? 250);
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
