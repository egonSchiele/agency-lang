import { describe, expect, it } from "vitest";
import { isAudioFormat, resolveFormat } from "../src/audioFormat.js";

describe("resolveFormat", () => {
  it.each([
    ["", "", "wav"],
    ["", "report", "wav"],
    ["", "report.wav", "wav"],
    ["", "report.MP3", "mp3"],
    ["", "talk.m4a", "m4a"],
    ["", "notes.ogg", "ogg"],
    ["mp3", "report.wav", "mp3"],
    ["m4a", "", "m4a"],
  ])("format %o with output file %o gives %o", (format, outputFile, expected) => {
    expect(resolveFormat(format, outputFile)).toBe(expected);
  });
});

describe("isAudioFormat", () => {
  it("knows the three formats and nothing else", () => {
    expect(["wav", "mp3", "m4a"].every(isAudioFormat)).toBe(true);
    expect(isAudioFormat("ogg")).toBe(false);
    expect(isAudioFormat("WAV")).toBe(false);
  });
});
