import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  currentFileSize,
  makeLineReader,
  makeLineSplitter,
  READ_CHUNK_BYTES,
} from "./lineReader.js";

describe("makeLineSplitter", () => {
  it("returns complete lines and keeps the partial one", () => {
    const splitter = makeLineSplitter();
    expect(splitter.push(Buffer.from("one\ntwo\nthr"))).toEqual(["one", "two"]);
    expect(splitter.pendingBytes()).toBe(3);
    expect(splitter.push(Buffer.from("ee\n"))).toEqual(["three"]);
    expect(splitter.pendingBytes()).toBe(0);
  });

  it("completes a line that spans many chunks", () => {
    const splitter = makeLineSplitter();
    expect(splitter.push(Buffer.from("a"))).toEqual([]);
    expect(splitter.push(Buffer.from("b"))).toEqual([]);
    expect(splitter.pendingBytes()).toBe(2);
    expect(splitter.push(Buffer.from("c\nd"))).toEqual(["abc"]);
    expect(splitter.pendingBytes()).toBe(1);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const splitter = makeLineSplitter();
    const heart = Buffer.from("❤\n"); // 3 bytes of UTF-8, then the newline
    expect(splitter.push(heart.subarray(0, 1))).toEqual([]);
    expect(splitter.push(heart.subarray(1))).toEqual(["❤"]);
  });

  it("keeps empty lines, so line numbers stay true", () => {
    expect(makeLineSplitter().push(Buffer.from("a\n\nb\n"))).toEqual(["a", "", "b"]);
  });

  it("finish returns a partial last line that is complete JSON", () => {
    const splitter = makeLineSplitter();
    splitter.push(Buffer.from('{"a":1}\n{"b":2}'));
    expect(splitter.finish()).toEqual(['{"b":2}']);
  });

  it("finish leaves out a partial last line cut off mid-write", () => {
    const splitter = makeLineSplitter();
    splitter.push(Buffer.from('{"a":1}\n{"b":'));
    expect(splitter.finish()).toEqual([]);
  });

  it("finish keeps the bytes, so a later push can still complete the line", () => {
    const splitter = makeLineSplitter();
    splitter.push(Buffer.from('{"done":'));
    expect(splitter.finish()).toEqual([]);
    expect(splitter.push(Buffer.from("true}\n"))).toEqual(['{"done":true}']);
  });

  it("reset forgets the partial line", () => {
    const splitter = makeLineSplitter();
    splitter.push(Buffer.from('{"stale":true}'));
    splitter.reset();
    expect(splitter.finish()).toEqual([]);
    expect(splitter.push(Buffer.from("fresh\n"))).toEqual(["fresh"]);
  });
});

describe("makeLineReader", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "linereader-"));
    file = path.join(dir, "log.jsonl");
    fs.writeFileSync(file, "");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readAll(reader: ReturnType<typeof makeLineReader>): string[] {
    const lines: string[] = [];
    reader.readToEnd((batch) => lines.push(...batch));
    return lines;
  }

  it("reads the whole file from offset 0, then only what was appended", () => {
    fs.writeFileSync(file, "first\n");
    const reader = makeLineReader(file, 0);
    expect(readAll(reader)).toEqual(["first"]);
    expect(readAll(reader)).toEqual([]);
    fs.appendFileSync(file, "second\n");
    expect(readAll(reader)).toEqual(["second"]);
  });

  it("holds a line until its newline arrives", () => {
    const reader = makeLineReader(file, 0);
    fs.appendFileSync(file, '{"a":');
    expect(readAll(reader)).toEqual([]);
    expect(reader.pendingBytes()).toBe(5);
    fs.appendFileSync(file, "1}\n");
    expect(readAll(reader)).toEqual(['{"a":1}']);
  });

  it("finish gives a finished file's complete last line as one more batch", () => {
    fs.writeFileSync(file, '{"a":1}\n{"b":2}');
    const reader = makeLineReader(file, 0);
    expect(readAll(reader)).toEqual(['{"a":1}']);
    expect(reader.finish()).toEqual(['{"b":2}']);
  });

  it("reads a line longer than a chunk whole", () => {
    const long = "x".repeat(READ_CHUNK_BYTES * 2 + 17);
    fs.writeFileSync(file, `${long}\nshort\n`);
    expect(readAll(makeLineReader(file, 0))).toEqual([long, "short"]);
  });

  it("readChunk reads at most one chunk", () => {
    const line = "y".repeat(1000);
    const lineCount = Math.ceil((READ_CHUNK_BYTES * 3) / (line.length + 1));
    fs.writeFileSync(file, `${line}\n`.repeat(lineCount));
    const reader = makeLineReader(file, 0);
    const first = reader.readChunk();
    expect(first.atEnd).toBe(false);
    expect(first.lines.length).toBeLessThan(lineCount);
    let total = first.lines.length;
    for (let chunk = reader.readChunk(); ; chunk = reader.readChunk()) {
      total += chunk.lines.length;
      if (chunk.atEnd) {
        break;
      }
    }
    expect(total).toBe(lineCount);
  });

  // /dev/fd lists the descriptors this process has open, on macOS and Linux.
  it.skipIf(!fs.existsSync("/dev/fd"))(
    "keeps one descriptor open across readChunk calls and closes it at the end",
    () => {
      const openCount = (): number => fs.readdirSync("/dev/fd").length;
      const line = "z".repeat(1000);
      fs.writeFileSync(file, `${line}\n`.repeat(Math.ceil((READ_CHUNK_BYTES * 3) / 1001)));
      const before = openCount();
      const reader = makeLineReader(file, 0);
      expect(reader.readChunk().atEnd).toBe(false);
      expect(openCount()).toBe(before + 1);
      expect(reader.readChunk().atEnd).toBe(false);
      expect(openCount()).toBe(before + 1);
      while (!reader.readChunk().atEnd) {
        // read on to the end
      }
      expect(openCount()).toBe(before);
    },
  );

  it("close releases the descriptor of a reader that stopped early", () => {
    fs.writeFileSync(file, `${"w".repeat(1000)}\n`.repeat(1000));
    const reader = makeLineReader(file, 0);
    reader.readChunk();
    reader.close();
    reader.close();
    expect(readAll(reader).length).toBeGreaterThan(0);
  });

  it("a shrunken file rewinds to offset 0", () => {
    fs.writeFileSync(file, "a long first line\n");
    const reader = makeLineReader(file, 0);
    readAll(reader);
    fs.writeFileSync(file, "new\n");
    expect(readAll(reader)).toEqual([]); // the rewind read
    expect(readAll(reader)).toEqual(["new"]);
  });

  it("startOffset skips what is already in the file", () => {
    fs.writeFileSync(file, "old\n");
    const reader = makeLineReader(file, currentFileSize(file));
    expect(readAll(reader)).toEqual([]);
    fs.appendFileSync(file, "fresh\n");
    expect(readAll(reader)).toEqual(["fresh"]);
  });

  it("reads a missing file as empty", () => {
    const missing = path.join(dir, "not-yet.jsonl");
    const reader = makeLineReader(missing, 0);
    expect(readAll(reader)).toEqual([]);
    fs.writeFileSync(missing, "arrived\n");
    expect(readAll(reader)).toEqual(["arrived"]);
  });
});
