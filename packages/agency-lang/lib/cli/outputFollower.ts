// Printing a detached program's saved output as it grows, for `agency
// attach` (docs/dev/runtime/spawn.md). The file's size is polled:
// `fs.watch` behaves differently on each platform.
import * as fs from "fs";
import { StringDecoder } from "string_decoder";

/** How often the output file is checked for more. */
export const OUTPUT_POLL_MS = 200;
const READ_CHUNK_BYTES = 64 * 1024;

/** Runs `tick` every `ms` until the returned function is called. A test
 *  passes one it drives by hand. */
export type Repeater = (tick: () => void, ms: number) => () => void;

const everyInterval: Repeater = (tick, ms) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export type OutputFollower = {
  /** Print what the file holds, then what is added to it. */
  start(): void;
  /** Stop printing, while a prompt has the terminal. */
  pause(): void;
  /** Print what was added while paused, and go on printing. */
  resume(): void;
  /** Print the rest of the file and stop. */
  finish(): void;
};

/** Follow `file`, handing each new piece of text to `write`. Throws when
 *  `file` is a symbolic link: the path came from a record on disk, and a
 *  link there could point anywhere. */
export function outputFollower(
  file: string,
  write: (text: string) => void,
  repeat: Repeater = everyInterval,
): OutputFollower {
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`the output file ${file} is a symbolic link`);
  }
  // A character split across two reads is held until its last byte comes.
  const decoder = new StringDecoder("utf8");
  let position = 0;
  let stop: (() => void) | null = null;

  const catchUp = (): void => {
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      // Removed since: there is nothing more to print.
      return;
    }
    try {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      let read = fs.readSync(descriptor, chunk, 0, chunk.length, position);
      while (read > 0) {
        position += read;
        write(decoder.write(chunk.subarray(0, read)));
        read = fs.readSync(descriptor, chunk, 0, chunk.length, position);
      }
    } finally {
      fs.closeSync(descriptor);
    }
  };
  const poll = (): void => {
    catchUp();
    stop = repeat(catchUp, OUTPUT_POLL_MS);
  };
  const halt = (): void => {
    stop?.();
    stop = null;
  };
  return {
    start: poll,
    pause: halt,
    resume: poll,
    finish: () => {
      halt();
      catchUp();
    },
  };
}
