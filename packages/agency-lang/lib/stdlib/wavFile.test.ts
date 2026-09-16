import { describe, expect, it } from "vitest";
import { wavFile, concatBytes } from "./wavFile.js";

const RATE = 24000;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

describe("wavFile", () => {
  it("writes a mono 16-bit PCM header in front of the samples", () => {
    const pcm = new Uint8Array(RATE * 2);
    const bytes = wavFile([pcm], RATE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.length).toBe(44 + pcm.length);
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + pcm.length);
    expect(ascii(bytes, 8, 8)).toBe("WAVEfmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint32(28, true)).toBe(RATE * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(bytes, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.length);
  });

  it("joins chunks in order", () => {
    const bytes = wavFile([Uint8Array.of(1, 2), Uint8Array.of(3)], RATE);
    expect([...bytes.slice(44)]).toEqual([1, 2, 3]);
    expect([...concatBytes([Uint8Array.of(9), Uint8Array.of(8, 7)])]).toEqual([9, 8, 7]);
  });
});
