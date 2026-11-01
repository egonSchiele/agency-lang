import * as fs from "node:fs";

/**
 * Reading a statelog one line at a time. `makeLineSplitter` turns bytes into
 * complete lines; `makeLineReader` feeds it a file in chunks.
 *
 * Lines are split on the newline byte before they are decoded. That byte
 * never appears inside a multi-byte UTF-8 character, so each line decodes on
 * its own, and a chunk boundary inside a character needs no special care.
 */

const NEWLINE = 0x0a;

/** How many bytes a reader reads from the file at a time. */
export const READ_CHUNK_BYTES = 256 * 1024;

export type LineSplitter = {
  /** The complete lines finished by `chunk`. The bytes after the last
   *  newline are kept as the partial line, for a later push to complete. */
  push(chunk: Buffer): string[];
  /** For a source that has ended: the partial last line as one more batch of
   *  lines. See `finishedTail`. */
  finish(): string[];
  /** How many bytes the partial line holds. */
  pendingBytes(): number;
  /** Forget the partial line. */
  reset(): void;
};

export function makeLineSplitter(): LineSplitter {
  // The partial line, as the chunks it arrived in. It is joined once, when
  // its newline arrives, so a very long line is copied once and not once per
  // chunk.
  let pending: Buffer[] = [];
  let pendingLength = 0;

  const takeLine = (end: Buffer): string => {
    if (pending.length === 0) {
      return end.toString("utf8");
    }
    const line = Buffer.concat([...pending, end], pendingLength + end.length).toString("utf8");
    pending = [];
    pendingLength = 0;
    return line;
  };

  return {
    push(chunk: Buffer): string[] {
      const lines: string[] = [];
      let lineStart = 0;
      let newlineAt = chunk.indexOf(NEWLINE);
      while (newlineAt !== -1) {
        lines.push(takeLine(chunk.subarray(lineStart, newlineAt)));
        lineStart = newlineAt + 1;
        newlineAt = chunk.indexOf(NEWLINE, lineStart);
      }
      if (lineStart < chunk.length) {
        pending.push(chunk.subarray(lineStart));
        pendingLength += chunk.length - lineStart;
      }
      return lines;
    },
    finish(): string[] {
      if (pendingLength === 0) {
        return [];
      }
      return finishedTail(Buffer.concat(pending, pendingLength).toString("utf8"));
    },
    pendingBytes: () => pendingLength,
    reset(): void {
      pending = [];
      pendingLength = 0;
    },
  };
}

/**
 * The one rule for the partial last line of a statelog that has ended: it is
 * a line when it holds a complete JSON value, and it is left out when it does
 * not, since that is a write cut off partway. A reader of a file that is still
 * being written does not ask: its partial line may be half written, and the
 * rest is still to come.
 */
function finishedTail(text: string): string[] {
  try {
    JSON.parse(text);
  } catch {
    // Not complete JSON: a cut-off write, which the rule leaves out.
    return [];
  }
  return [text];
}

export type LineChunk = {
  lines: string[];
  /** True when the reader has reached the end of the file as it is now. */
  atEnd: boolean;
};

export type LineReader = {
  /** Read at most `READ_CHUNK_BYTES` and return the lines that finished. */
  readChunk(): LineChunk;
  /** Read to the end of the file as it is now, handing over the lines that
   *  finish one chunk at a time, so no caller holds the whole file. */
  readToEnd(onLines: (lines: string[]) => void): void;
  /** For a finished file: the partial last line as one more batch of lines,
   *  under the rule in `finishedTail`. The reader keeps the bytes, so a viewer
   *  that starts following the file afterwards can still complete the line. */
  finish(): string[];
  /** How many bytes the partial last line holds. */
  pendingBytes(): number;
  /** Close the file. A read that reaches the end closes it by itself, so only
   *  a caller that stops early needs this. */
  close(): void;
};

/**
 * A reader of a file that may still be growing. Each read picks up where the
 * last one stopped, and the file stays open from one read to the next until a
 * read reaches the end. `startOffset` is where reading begins: 0 reads the
 * whole file; `currentFileSize(path)` reads only what is appended later. A
 * missing file reads as empty. A file that shrank (rotated or truncated)
 * rewinds to the start, and that read returns no lines.
 */
export function makeLineReader(path: string, startOffset = 0): LineReader {
  const splitter = makeLineSplitter();
  let offset = startOffset;
  let fd: number | undefined;

  const closeFile = (): void => {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fd = undefined;
    }
  };

  // Reads up to `maxChunks` chunks from `openFd`; false when the file turned
  // out shorter than it was measured.
  const readFrom = (
    openFd: number,
    size: number,
    maxChunks: number,
    onLines: (lines: string[]) => void,
  ): boolean => {
    for (let chunks = 0; chunks < maxChunks && offset < size; chunks += 1) {
      const bytes = readBytes(openFd, offset, Math.min(READ_CHUNK_BYTES, size - offset));
      if (bytes.length === 0) {
        return false;
      }
      offset += bytes.length;
      const lines = splitter.push(bytes);
      if (lines.length > 0) {
        onLines(lines);
      }
    }
    return true;
  };

  // Reads up to `maxChunks` chunks and returns whether it reached the end.
  const readChunks = (maxChunks: number, onLines: (lines: string[]) => void): boolean => {
    const size = currentFileSize(path);
    if (size < offset) {
      closeFile();
      offset = 0;
      splitter.reset();
      return true;
    }
    let whole = true;
    if (offset < size) {
      fd ??= fs.openSync(path, "r");
      try {
        whole = readFrom(fd, size, maxChunks, onLines);
      } catch (error) {
        closeFile();
        throw error;
      }
    }
    // A short read means the file shrank after it was measured; the next
    // read rewinds.
    const atEnd = !whole || offset >= size;
    if (atEnd) {
      closeFile();
    }
    return atEnd;
  };

  return {
    readChunk(): LineChunk {
      let lines: string[] = [];
      const atEnd = readChunks(1, (finished) => {
        lines = finished;
      });
      return { lines, atEnd };
    },
    readToEnd(onLines: (lines: string[]) => void): void {
      readChunks(Infinity, onLines);
    },
    finish: () => splitter.finish(),
    pendingBytes: () => splitter.pendingBytes(),
    close: closeFile,
  };
}

function readBytes(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** The file's size right now; 0 when it does not exist yet. */
export function currentFileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}
