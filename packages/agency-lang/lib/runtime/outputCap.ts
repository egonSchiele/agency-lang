// A limit on what a detached program saves to its output file. The
// command that started the program has exited by then, so the program
// limits itself (docs/dev/runtime/spawn.md).

/** The part of a stream the cap wraps. */
export type CappedStream = {
  write: (...args: any[]) => boolean;
};

const MEBIBYTE = 1024 * 1024;

function limitNotice(limitBytes: number): string {
  const size = limitBytes % MEBIBYTE === 0 ? `${limitBytes / MEBIBYTE} MiB` : `${limitBytes} bytes`;
  return `\n[agency] output limit of ${size} reached; nothing more is saved\n`;
}

function byteLength(chunk: unknown): number {
  return typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk as Uint8Array).byteLength;
}

/** The first `bytes` bytes of `chunk`. A character cut in half at the end
 *  of a string is left out. */
function firstBytes(chunk: unknown, bytes: number): Uint8Array | string {
  if (typeof chunk === "string") {
    return Buffer.from(chunk).subarray(0, bytes).toString().replace(/�$/, "");
  }
  return (chunk as Uint8Array).subarray(0, bytes);
}

function capStream(stream: CappedStream, limitBytes: number): void {
  const write = stream.write.bind(stream);
  let written = 0;
  let full = false;
  stream.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    // A write may pass a callback last. It is called either way, so a
    // caller that waits on it is not left waiting.
    const done = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
    if (full) {
      done?.();
      return true;
    }
    const size = byteLength(chunk);
    if (written + size <= limitBytes) {
      written += size;
      return write(chunk, ...rest);
    }
    full = true;
    write(firstBytes(chunk, limitBytes - written));
    return write(limitNotice(limitBytes), done);
  };
}

/** Stop writing to standard output and standard error once each has
 *  written `limitBytes`. The line written at the limit says so, and what
 *  follows is dropped. The cap covers what this process writes: a child
 *  process that inherited the same file writes past it. */
export function capOutput(
  limitBytes: number,
  streams: CappedStream[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    capStream(stream, limitBytes);
  }
}
