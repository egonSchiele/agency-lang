import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Incremental reader of a file another process is appending to: each read()
 * returns the text added since the last read ("" when nothing new). The one
 * append-reading implementation — the log viewer's follow mode and the eval
 * cost tailer both build on it.
 *
 * `startOffset` is where reading begins: 0 (the default) reads the whole
 * file; pass `currentFileSize(path)` to emit only future appends.
 *
 * Two mid-write hazards are handled here so callers never see them: a poll
 * can split a multi-byte UTF-8 character (StringDecoder holds the partial
 * bytes until the next read completes them), and a short read must only
 * consume what was actually read. A file that shrank (rotation/truncation)
 * rewinds to the start.
 */
export function makeAppendReader(path: string, startOffset = 0): { read(): string } {
  let offset = startOffset;
  let decoder = new StringDecoder("utf-8");

  return {
    read(): string {
      const size = currentFileSize(path);
      if (size < offset) {
        offset = 0;
        decoder = new StringDecoder("utf-8");
        return "";
      }
      if (size === offset) {
        return "";
      }
      const fd = fs.openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
        offset += bytesRead;
        return decoder.write(buf.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/** The file's size right now; 0 when it does not exist yet. */
export function currentFileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}
