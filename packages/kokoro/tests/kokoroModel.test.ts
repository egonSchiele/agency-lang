// listenerBaseline must be the first import, so its snapshot is taken
// before kokoro-js loads.
import { listenersBeforeImport } from "./listenerBaseline.js";
import { describe, expect, it } from "vitest";
import { textPieces } from "../src/kokoroModel.js";
import { snapshotListeners } from "../src/processListeners.js";
import { MAX_CHUNK_CHARS } from "../src/textChunks.js";

// kokoro-js's splitter alone takes close to a minute on this text.
const SPLIT_TIME_LIMIT_MS = 5000;

describe("importing kokoroModel", () => {
  it("leaves no uncaughtException or unhandledRejection listener behind", () => {
    expect(snapshotListeners()).toEqual(listenersBeforeImport);
  });
});

describe("textPieces", () => {
  it("gives one piece per sentence", () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `This is sentence number ${index + 1}.`,
    ).join(" ");
    expect(textPieces(text)).toHaveLength(40);
  });

  it("splits a sentence too long for the model", () => {
    const sentence = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ") + ".";
    const pieces = textPieces(sentence);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(pieces.join(" ")).toBe(sentence);
  });

  it("splits a long run of periods quickly", () => {
    const text = "Mr" + ".".repeat(50_000) + " end.";
    const started = performance.now();
    const pieces = textPieces(text);

    expect(performance.now() - started).toBeLessThan(SPLIT_TIME_LIMIT_MS);
    expect(pieces.every((piece) => piece.length <= MAX_CHUNK_CHARS)).toBe(true);
  });
});
