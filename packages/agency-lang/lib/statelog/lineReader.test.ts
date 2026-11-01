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
    expect(splitter.tail()).toBe("thr");
    expect(splitter.push(Buffer.from("ee\n"))).toEqual(["three"]);
    expect(splitter.tail()).toBeUndefined();
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

  it("tail leaves the partial line in place for a later push", () => {
    const splitter = makeLineSplitter();
    splitter.push(Buffer.from('{"done":'));
    expect(splitter.tail()).toBe('{"done":');
    expect(splitter.push(Buffer.from("true}\n"))).toEqual(['{"done":true}']);
  });

  it("reset forgets the partial line", () => {
    const splitter = makeLineSplitter();
    splitter.push(Buffer.from("partial"));
    splitter.reset();
    expect(splitter.tail()).toBeUndefined();
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
    expect(reader.tail()).toBe('{"a":');
    fs.appendFileSync(file, "1}\n");
    expect(readAll(reader)).toEqual(['{"a":1}']);
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
