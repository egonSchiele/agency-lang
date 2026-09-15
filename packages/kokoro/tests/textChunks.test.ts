import { describe, expect, it } from "vitest";
import { MAX_CHUNK_CHARS, sentenceWindows, splitToFit } from "../src/textChunks.js";

describe("splitToFit", () => {
  it("leaves a short sentence whole", () => {
    expect(splitToFit("The build finished.")).toEqual(["The build finished."]);
  });

  it("splits a long sentence with no commas at spaces, keeping every word", () => {
    const sentence = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
    const pieces = splitToFit(sentence);

    expect(sentence.length).toBeGreaterThan(MAX_CHUNK_CHARS * 2);
    expect(pieces.every((piece) => piece.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(pieces.join(" ")).toBe(sentence);
  });

  it("splits at commas before spaces", () => {
    const clause = "a".repeat(40) + " " + "b".repeat(40);
    const sentence = [clause, clause, clause, clause].join(", ") + ".";
    const pieces = splitToFit(sentence, 170);

    expect(pieces).toEqual([`${clause}, ${clause},`, `${clause}, ${clause}.`]);
  });

  it("cuts a word longer than the limit", () => {
    expect(splitToFit(`${"a".repeat(25)} end.`, 10)).toEqual([
      "a".repeat(10),
      "a".repeat(10),
      "aaaaa end.",
    ]);
  });
});

describe("sentenceWindows", () => {
  it("breaks between sentences and keeps each window under the limit", () => {
    const sentence = "This sentence is exactly forty chars ok.";
    const text = Array.from({ length: 10 }, () => sentence).join(" ");
    const windows = sentenceWindows(text, 100);

    expect(windows).toEqual(Array.from({ length: 5 }, () => `${sentence} ${sentence}`));
  });
});
