import { describe, expect, it } from "vitest";
import { validateSpeakArguments, type SpeakArguments } from "../src/argumentChecks.js";

const VALID: SpeakArguments = {
  text: "Hello from Agency.",
  outputFile: "hello.wav",
  voice: "af_heart",
  model: "fp32",
  speed: 1,
};

describe("validateSpeakArguments", () => {
  it("accepts valid arguments", () => {
    expect(() => validateSpeakArguments(VALID)).not.toThrow();
  });

  it.each([
    [{ text: "  " }, /text cannot be empty/],
    [{ text: "a".repeat(50_001) }, /over the limit of 50000/],
    [{ voice: "af_nobody" }, /unknown voice "af_nobody"/],
    [{ model: "q4" }, /unknown model "q4"/],
    [{ speed: 3 }, /speed must be between 0.5 and 2/],
    [{ speed: Number.NaN }, /speed must be between/],
    [{ outputFile: "hello.mp3" }, /must end in .wav/],
  ])("rejects %o", (change, message) => {
    expect(() => validateSpeakArguments({ ...VALID, ...change })).toThrow(message);
  });

  it.each(["", "report", "REPORT.WAV"])("accepts the output file %o", (outputFile) => {
    expect(() => validateSpeakArguments({ ...VALID, outputFile })).not.toThrow();
  });
});
