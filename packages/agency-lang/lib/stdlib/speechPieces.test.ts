import { describe, expect, it } from "vitest";
import { sentencePieces, splitToFit } from "./speechPieces.js";

describe("splitToFit", () => {
  it("leaves a short sentence whole", () => {
    expect(splitToFit("The build finished.", 500)).toEqual(["The build finished."]);
  });

  it("splits a long sentence with no commas at spaces, keeping every word", () => {
    const sentence = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
    const pieces = splitToFit(sentence, 250);
    expect(sentence.length).toBeGreaterThan(500);
    expect(pieces.every((piece) => piece.length <= 250)).toBe(true);
    expect(pieces.join(" ")).toBe(sentence);
  });

  it("splits at commas before spaces", () => {
    const clause = "a".repeat(40) + " " + "b".repeat(40);
    const sentence = [clause, clause, clause, clause].join(", ") + ".";
    expect(splitToFit(sentence, 170)).toEqual([`${clause}, ${clause},`, `${clause}, ${clause}.`]);
  });

  it("cuts a word longer than the limit", () => {
    expect(splitToFit(`${"a".repeat(25)} end.`, 10)).toEqual([
      "a".repeat(10),
      "a".repeat(10),
      "aaaaa end.",
    ]);
  });
});

describe("sentencePieces", () => {
  it("breaks between sentences and keeps each piece under the limit", () => {
    const sentence = "This sentence is exactly forty chars ok.";
    const text = Array.from({ length: 10 }, () => sentence).join(" ");
    expect(sentencePieces(text, 100)).toEqual(
      Array.from({ length: 5 }, () => `${sentence} ${sentence}`),
    );
  });

  it("keeps every non-space character of a 2,000-character text, in order, in pieces of at most 500", () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `Sentence number ${i} says something short.`,
    ).join(" ");
    const pieces = sentencePieces(text, 500);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.every((p) => p.length <= 500)).toBe(true);
    expect(pieces.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  // Intl.Segmenter ends a sentence only when a capital letter follows, so a
  // tag such as <sigh> keeps the segment open and travels with the words it
  // belongs to. That is what matters here: a tag must never be spoken on its
  // own, away from its sentence.
  it("keeps an Orpheus tag with the words it belongs to", () => {
    expect(sentencePieces("<gasp> Stop! Then, calmly. <sigh> Fine.", 20)).toEqual([
      "<gasp> Stop! Then,",
      "calmly. <sigh> Fine.",
    ]);
  });

  // Pieces are joined with a space, so a merged pair of sentences gains one.
  // A space between two sentences is harmless to a speech model; losing a
  // character would not be.
  it("splits Chinese and Japanese text between sentences", () => {
    const zh = sentencePieces("你好。今天怎么样？我很好。", 8);
    expect(zh).toEqual(["你好。", "今天怎么样？", "我很好。"]);
    expect(zh.every((p) => p.length <= 8)).toBe(true);
    const ja = sentencePieces("こんにちは。元気ですか？はい。", 10);
    expect(ja).toEqual(["こんにちは。", "元気ですか？ はい。"]);
    expect(ja.join("").replace(/\s+/g, "")).toBe("こんにちは。元気ですか？はい。");
  });
});
