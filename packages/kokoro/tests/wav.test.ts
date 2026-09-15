import { describe, expect, it } from "vitest";
import { encodeWav, toPcm16 } from "../src/wav.js";

const SAMPLE_RATE = 24000;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function sampleAt(bytes: Uint8Array, index: number): number {
  return new DataView(bytes.buffer).getInt16(44 + index * 2, true);
}

describe("toPcm16", () => {
  it("clamps samples outside -1 to 1 and scales the rest", () => {
    expect([...toPcm16(Float32Array.of(2, -2, 0.5))]).toEqual([32767, -32768, 16384]);
  });
});

describe("encodeWav", () => {
  it("writes a mono 16-bit PCM header", () => {
    const bytes = encodeWav([new Int16Array(SAMPLE_RATE)], SAMPLE_RATE);
    const view = new DataView(bytes.buffer);
    const dataBytes = SAMPLE_RATE * 2;

    expect(bytes.length).toBe(44 + dataBytes);
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + dataBytes);
    expect(ascii(bytes, 8, 8)).toBe("WAVEfmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(SAMPLE_RATE * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(bytes, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(dataBytes);
  });

  it("joins chunks in order", () => {
    const bytes = encodeWav([Int16Array.of(8192, 1), Int16Array.of(-8192)], SAMPLE_RATE);
    expect([0, 1, 2].map((index) => sampleAt(bytes, index))).toEqual([8192, 1, -8192]);
  });
});
