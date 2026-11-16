// Printing a detached program's saved output as it grows, for `agency
// attach` (docs/dev/runtime/spawn.md). The file's size is polled:
// `fs.watch` behaves differently on each platform.
import * as fs from "fs";
import { StringDecoder } from "string_decoder";

/** How often the output file is checked for more. */
export const OUTPUT_POLL_MS = 200;
const READ_CHUNK_BYTES = 64 * 1024;
/** How much of the output saved so far is printed at the start. A
 *  detached program may have saved megabytes, and printing all of it
 *  would push the question it is waiting on off the screen. */
export const START_TAIL_BYTES = 64 * 1024;
/** A UTF-8 character is at most this many bytes. */
const LONGEST_CHARACTER_BYTES = 4;

/** Where printing starts: the last `START_TAIL_BYTES` of `file`, moved
 *  forward to the start of a character. Zero for a smaller file. */
function startPosition(file: string): number {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    // Removed since: there is nothing to print.
    return 0;
  }
  try {
    const tail = Math.max(0, fs.fstatSync(descriptor).size - START_TAIL_BYTES);
    if (tail === 0) {
      return 0;
    }
    const first = Buffer.alloc(LONGEST_CHARACTER_BYTES);
    const read = fs.readSync(descriptor, first, 0, first.length, tail);
    // A byte of the form 10xxxxxx continues a character that began earlier.
    const continuing = [...first.subarray(0, read)].findIndex((byte) => (byte & 0xc0) !== 0x80);
    return tail + (continuing === -1 ? read : continuing);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Runs `tick` every `ms` until the returned function is called. A test
 *  passes one it drives by hand. */
export type Repeater = (tick: () => void, ms: number) => () => void;

const everyInterval: Repeater = (tick, ms) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export type OutputFollower = {
  /** Print the last part of what the file holds, then what is added to
   *  it. Says so when earlier output was skipped. */
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
  let finished = false;

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
  // Does nothing while already polling, and after `finish`: a second
  // timer would be lost and never stopped.
  const poll = (): void => {
    if (finished || stop !== null) {
      return;
    }
    catchUp();
    stop = repeat(catchUp, OUTPUT_POLL_MS);
  };
  const halt = (): void => {
    stop?.();
    stop = null;
  };
  let started = false;
  return {
    start: () => {
      if (!started) {
        started = true;
        position = startPosition(file);
        if (position > 0) {
          write(`[agency] Skipped ${position} bytes of earlier output. All of it is in ${file}\n`);
        }
      }
      poll();
    },
    pause: halt,
    resume: poll,
    finish: () => {
      halt();
      catchUp();
      finished = true;
    },
  };
}
