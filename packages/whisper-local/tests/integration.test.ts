import { describe, it, expect } from "vitest";
import { transcribe } from "../src/transcribe.js";
import { _clearHandleCache } from "../src/handleCache.js";

const SLOW = process.env.AGENCY_RUN_SLOW === "1";

describe.skipIf(!SLOW)("integration: real transcription", () => {
  it(
    "transcribes hello.wav with tiny.en",
    async () => {
      _clearHandleCache();
      const text = await transcribe(
        "tests/fixtures/hello.wav",
        "en",
        "tiny.en",
      );
      // The fixture says "hello" (and likely a brief greeting). Adjust the
      // regex to match the actual content of hello.wav once the implementer
      // has run the test once and observed the output. Keep it a substring
      // match, not exact equality, since whisper output is non-deterministic.
      expect(text.toLowerCase()).toMatch(/hello/);
    },
    60_000,
  );
});
