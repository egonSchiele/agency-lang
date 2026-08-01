// Direct coverage of the append reader's hazards — rescued from the old
// follow.test.ts before follow.ts dissolved into the viewer shell; these
// were the only tests pinning the UTF-8 split behavior appendReader
// documents.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentFileSize, makeAppendReader } from "./appendReader.js";

describe("makeAppendReader", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "appendreader-"));
    file = path.join(dir, "log.jsonl");
    fs.writeFileSync(file, "");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the whole file from offset 0, then only what was appended", () => {
    fs.writeFileSync(file, "first\n");
    const reader = makeAppendReader(file, 0);
    expect(reader.read()).toBe("first\n");
    expect(reader.read()).toBe("");
    fs.appendFileSync(file, "second\n");
    expect(reader.read()).toBe("second\n");
  });

  it("reassembles a multi-byte char split across read boundaries", () => {
    const reader = makeAppendReader(file, 0);
    const heart = Buffer.from("❤");        // 3 bytes in UTF-8
    fs.appendFileSync(file, heart.subarray(0, 1));
    expect(reader.read()).toBe("");         // partial char held, not corrupted
    fs.appendFileSync(file, heart.subarray(1));
    expect(reader.read()).toBe("❤");
  });

  it("a shrunken file rewinds to offset 0 (rotation/truncation)", () => {
    fs.writeFileSync(file, "a long first line\n");
    const reader = makeAppendReader(file, 0);
    reader.read();
    fs.writeFileSync(file, "new\n");
    reader.read();                          // the rewind poll
    expect(reader.read()).toBe("new\n");
  });

  it("startOffset skips existing content (follow-style tailing)", () => {
    fs.writeFileSync(file, "old\n");
    const reader = makeAppendReader(file, currentFileSize(file));
    expect(reader.read()).toBe("");
    fs.appendFileSync(file, "fresh\n");
    expect(reader.read()).toBe("fresh\n");
  });
});
