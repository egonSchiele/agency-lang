import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSafetensorsHeader, headerLength, MAX_HEADER_BYTES } from "./safetensors.js";
import { _loraInfo } from "./agency.js";

/** A safetensors file: the 8-byte header length, the JSON header, then
 *  the tensor bytes it describes. */
function safetensors(header: Record<string, unknown>, tensorBytes: number): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([length, json, Buffer.alloc(tensorBytes)]);
}

describe("readSafetensorsHeader", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "safetensors-")));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the metadata and counts the tensors without reading them", async () => {
    const file = path.join(dir, "a.safetensors");
    fs.writeFileSync(
      file,
      safetensors(
        {
          __metadata__: { trigger: "sketch", rank: "16", step: "1000", base: "noobai-XL-1.1" },
          "unet.a.lora_A.weight": { dtype: "F32", shape: [16, 4], data_offsets: [0, 256] },
          "unet.a.lora_B.weight": { dtype: "F32", shape: [4, 16], data_offsets: [256, 512] },
        },
        512,
      ),
    );
    const header = await readSafetensorsHeader(file);
    expect(header.metadata).toEqual({
      trigger: "sketch",
      rank: "16",
      step: "1000",
      base: "noobai-XL-1.1",
    });
    expect(header.tensorCount).toBe(2);
    expect(header.sizeBytes).toBe(fs.statSync(file).size);
    expect(await _loraInfo(file)).toEqual({
      base: "noobai-XL-1.1",
      trigger: "sketch",
      rank: 16,
      steps: 1000,
      sizeBytes: fs.statSync(file).size,
    });
  });

  it("refuses a file with no training metadata, a short file, and a huge header", async () => {
    const bare = path.join(dir, "bare.safetensors");
    fs.writeFileSync(
      bare,
      safetensors({ t: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }, 4),
    );
    await expect(_loraInfo(bare)).rejects.toThrow("carries no training metadata");
    const short = path.join(dir, "short.safetensors");
    fs.writeFileSync(short, Buffer.from([1, 2, 3]));
    await expect(readSafetensorsHeader(short)).rejects.toThrow("too short");
    const huge = path.join(dir, "huge.safetensors");
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(MAX_HEADER_BYTES + 1));
    fs.writeFileSync(huge, Buffer.concat([length, Buffer.alloc(16)]));
    await expect(readSafetensorsHeader(huge)).rejects.toThrow("far smaller");
  });

  it("refuses a bogus length as soon as the length field is read", async () => {
    // The check sits in headerLength, which readHead calls on the first 8
    // bytes, so a length of 2^40 stops the read there instead of reading
    // the whole file looking for a header that long.
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(2n ** 40n);
    expect(() => headerLength(length, "big.safetensors")).toThrow("far smaller");
    const big = path.join(dir, "big.safetensors");
    fs.writeFileSync(big, Buffer.concat([length, Buffer.alloc(4 * 1024 * 1024)]));
    await expect(readSafetensorsHeader(big)).rejects.toThrow("far smaller");
  });

  it("refuses a symlink", async () => {
    const file = path.join(dir, "a.safetensors");
    fs.writeFileSync(file, safetensors({ __metadata__: {} }, 0));
    fs.symlinkSync(file, path.join(dir, "link.safetensors"));
    await expect(readSafetensorsHeader(path.join(dir, "link.safetensors"))).rejects.toThrow();
  });
});
