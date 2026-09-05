import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile, stat, symlink, chmod } from "fs/promises";
import os from "os";
import path from "path";
import { realpathSync } from "fs";
import { agencyStore } from "../runtime/asyncContext.js";
import { InvocationUsageMeter } from "../runtime/invocationUsage.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import { _transcribe, _synthesizeSpeech, publishSpeechOutput } from "./speech.js";

// Each test gets a unique disposable root; nothing touches $HOME, the repo, or a
// shared /tmp path (see plan §12j).
let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "agency-speech-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeStack() {
  const stack = {
    localCost: 0,
    localTokens: 0,
    chargeGuards: vi.fn(),
    enforceGuards: vi.fn(),
    billCharge: vi.fn((amount: number) => {
      stack.localCost += amount;
      stack.chargeGuards(amount);
    }),
  };
  return stack;
}

type TranscribeImpl = NonNullable<(input: any, config: any, signal: AbortSignal) => Promise<any>>;
type SpeakImpl = NonNullable<(text: string, config: any, signal: AbortSignal) => Promise<any>>;

async function withClient(
  client: { transcribe?: TranscribeImpl; speak?: SpeakImpl },
  fn: (helpers: {
    stack: ReturnType<typeof makeStack>;
    transcription: ReturnType<typeof vi.fn>;
    speechSynthesis: ReturnType<typeof vi.fn>;
    meter: InvocationUsageMeter;
    controller: AbortController;
  }) => Promise<void>,
) {
  const stack = makeStack();
  const transcription = vi.fn().mockResolvedValue(undefined);
  const speechSynthesis = vi.fn().mockResolvedValue(undefined);
  const meter = new InvocationUsageMeter();
  const controller = new AbortController();
  const store = {
    ctx: {
      llmClient: client,
      statelogClient: { transcription, speechSynthesis },
      invocationUsage: meter,
      getAbortSignal: () => controller.signal,
    },
    stack,
    threads: {},
    globals: {},
    callsite: { moduleId: "test", scopeName: "main", stepPath: "" },
  } as any;
  await agencyStore.run(store, () =>
    fn({ stack, transcription, speechSynthesis, meter, controller }),
  );
}

const trOk = (overrides: any = {}) => ({
  success: true,
  value: {
    text: "hello world",
    durationSeconds: 3,
    usage: { totalTokens: 7 },
    cost: { totalCost: 0.006, currency: "USD" },
    ...overrides,
  },
});
const speakOk = (overrides: any = {}) => ({
  success: true,
  value: {
    audio: new Uint8Array([9, 8, 7, 6]),
    mimeType: "audio/mpeg", // matches format "mp3"
    cost: { totalCost: 0.015, currency: "USD" },
    ...overrides,
  },
});

async function makeAudioFile(): Promise<string> {
  const p = path.join(root, "in.wav");
  await writeFile(p, Buffer.from([1, 2, 3, 4]));
  return p;
}

describe("_transcribe", () => {
  it("returns text and charges cost/tokens/guards + statelog on success", async () => {
    const filepath = await makeAudioFile();
    let captured: any;
    const transcribe: TranscribeImpl = async (source, config, signal) => {
      captured = { source, config, signal };
      return trOk();
    };
    await withClient({ transcribe }, async ({ stack, transcription, meter }) => {
      const text = await _transcribe(filepath, "en", [root], "whisper-1", "", "", "", "");
      expect(text).toBe("hello world");
      // the real path as a BlobRef + complete config forwarded
      expect(captured.source).toEqual({ kind: "path", path: realpathSync(filepath) });
      expect(captured.config.model).toBe("whisper-1");
      expect(captured.config.language).toBe("en");
      expect(stack.localCost).toBeCloseTo(0.006);
      expect(stack.localTokens).toBe(7);
      expect(transcription).toHaveBeenCalledTimes(1);
      expect(stack.enforceGuards).toHaveBeenCalled();
      const { usage } = meter.snapshot();
      expect(usage.unknownCostCallCount).toBe(0);
      expect(usage.entries).toHaveLength(1);
      expect(usage.entries[0].kind).toBe("transcription");
      expect(usage.entries[0].model).toBe("whisper-1");
    });
  });

  it("statelog carries a projected transcript preview, never audio bytes/raw", async () => {
    const filepath = await makeAudioFile();
    const transcribe: TranscribeImpl = async () =>
      trOk({
        text: "secret words",
        raw: { audio: "xxx" },
        usage: { totalTokens: 7, inputAudioTokens: 4 },
      });
    await withClient({ transcribe }, async ({ transcription }) => {
      await _transcribe(filepath, "", [root], "whisper-1", "", "", "", "");
      const arg = transcription.mock.calls[0][0];
      expect(arg.textPreview).toBe("secret words");
      expect(arg).not.toHaveProperty("raw");
      expect(JSON.stringify(arg)).not.toContain("inputAudioTokens");
    });
  });

  it("refuses a symlink at the input path before dispatch", async () => {
    const target = await makeAudioFile(); // real readable file inside root
    const linkPath = path.join(root, "link.wav");
    await symlink(target, linkPath);
    const transcribe = vi.fn();
    await withClient({ transcribe: transcribe as any }, async () => {
      await expect(_transcribe(linkPath, "", [root], "whisper-1", "", "", "", "")).rejects.toThrow(
        /symlink/,
      );
      expect(transcribe).not.toHaveBeenCalled();
    });
  });

  it("throws a clear error when the client has no transcribe() support", async () => {
    const filepath = await makeAudioFile();
    await withClient({}, async () => {
      await expect(_transcribe(filepath, "", [root], "whisper-1", "", "", "", "")).rejects.toThrow(
        /does not support transcription/,
      );
    });
  });

  it("a resolved failure Result records exactly one unresolved attempt and throws", async () => {
    const filepath = await makeAudioFile();
    const transcribe: TranscribeImpl = async () => ({ success: false, error: "boom" });
    await withClient({ transcribe }, async ({ stack, transcription, meter }) => {
      await expect(_transcribe(filepath, "", [root], "whisper-1", "", "", "", "")).rejects.toThrow(
        /transcribe failed: boom/,
      );
      const { usage } = meter.snapshot();
      expect(usage.unknownCostCallCount).toBe(1);
      expect(usage.pricingComplete).toBe(false);
      expect(stack.localCost).toBe(0); // an unresolved attempt bills no money
      expect(transcription).not.toHaveBeenCalled();
    });
  });

  it("a missing file throws before any dispatch (no client call, no attempt)", async () => {
    const transcribe = vi.fn();
    await withClient({ transcribe: transcribe as any }, async ({ meter }) => {
      await expect(
        _transcribe(path.join(root, "nope.wav"), "", [root], "whisper-1", "", "", "", ""),
      ).rejects.toThrow();
      expect(transcribe).not.toHaveBeenCalled();
      expect(meter.snapshot().usage.unknownCostCallCount).toBe(0);
    });
  });

  it("an already-aborted signal throws its reason before dispatch", async () => {
    const filepath = await makeAudioFile();
    const transcribe = vi.fn();
    await withClient({ transcribe: transcribe as any }, async ({ controller, meter }) => {
      const reason = new AgencyCancelledError("cancelled early");
      controller.abort(reason);
      await expect(_transcribe(filepath, "", [root], "whisper-1", "", "", "", "")).rejects.toBe(
        reason,
      );
      expect(transcribe).not.toHaveBeenCalled();
      expect(meter.snapshot().usage.unknownCostCallCount).toBe(0);
    });
  });

  it("a client that rejects on mid-flight abort records exactly one unresolved attempt and propagates the reason", async () => {
    const filepath = await makeAudioFile();
    const reason = new AgencyCancelledError("time guard");
    // Mirrors SmoltalkClient's abort→reject adaptation: the dispatched call
    // rejects with the branch reason once the signal fires mid-flight.
    const transcribe: TranscribeImpl = async () => {
      throw reason;
    };
    await withClient({ transcribe }, async ({ meter, transcription }) => {
      await expect(_transcribe(filepath, "", [root], "whisper-1", "", "", "", "")).rejects.toBe(
        reason,
      );
      const { usage } = meter.snapshot();
      expect(usage.unknownCostCallCount).toBe(1); // meteredDispatch records it
      expect(usage.pricingComplete).toBe(false);
      expect(transcription).not.toHaveBeenCalled();
    });
  });
});

describe("_synthesizeSpeech", () => {
  it("writes audio to a file and charges cost/guards + statelog (no tokens) on success", async () => {
    const out = path.join(root, "out.mp3");
    const speak: SpeakImpl = async () => speakOk();
    await withClient({ speak }, async ({ stack, speechSynthesis, meter }) => {
      const returned = await _synthesizeSpeech(
        "hi",
        out,
        "alloy",
        "tts-1",
        "",
        "mp3",
        1,
        [root],
        "",
      );
      expect(returned).toBe(path.join(realpathSync(root), "out.mp3"));
      expect(new Uint8Array(await readFile(out))).toEqual(new Uint8Array([9, 8, 7, 6]));
      expect(stack.localCost).toBeCloseTo(0.015);
      expect(stack.localTokens).toBe(0); // TTS is per-character, no tokens
      expect(speechSynthesis).toHaveBeenCalledTimes(1);
      expect(stack.enforceGuards).toHaveBeenCalled();
      const { usage } = meter.snapshot();
      expect(usage.entries).toHaveLength(1);
      expect(usage.entries[0].kind).toBe("speech");
    });
  });

  it("refuses to overwrite an existing file, before any paid dispatch", async () => {
    const out = path.join(root, "exists.mp3");
    await writeFile(out, Buffer.from([0]));
    const speak = vi.fn();
    await withClient({ speak: speak as any }, async ({ meter, stack }) => {
      await expect(
        _synthesizeSpeech("hi", out, "alloy", "tts-1", "", "mp3", 1, [root], ""),
      ).rejects.toThrow(/already exists/);
      expect(speak).not.toHaveBeenCalled();
      expect(meter.snapshot().usage.unknownCostCallCount).toBe(0);
      expect(stack.chargeGuards).not.toHaveBeenCalled();
    });
  });

  it("rejects an output extension that disagrees with the format, before dispatch", async () => {
    const out = path.join(root, "out.wav");
    const speak = vi.fn();
    await withClient({ speak: speak as any }, async () => {
      await expect(
        _synthesizeSpeech("hi", out, "alloy", "tts-1", "", "mp3", 1, [root], ""),
      ).rejects.toThrow(/does not match format/);
      expect(speak).not.toHaveBeenCalled();
    });
  });

  it("a guard trip after accounting writes NO file", async () => {
    const out = path.join(root, "trip.mp3");
    const speak: SpeakImpl = async () => speakOk({ cost: { totalCost: 99, currency: "USD" } });
    await withClient({ speak }, async ({ stack, speechSynthesis }) => {
      stack.enforceGuards.mockImplementation(() => {
        throw new Error("budget exceeded");
      });
      await expect(
        _synthesizeSpeech("hi", out, "alloy", "tts-1", "", "mp3", 1, [root], ""),
      ).rejects.toThrow(/budget exceeded/);
      // usage + statelog already recorded before the trip; no artifact on disk
      expect(speechSynthesis).toHaveBeenCalledTimes(1);
      await expect(stat(out)).rejects.toThrow();
    });
  });

  it("a returned MIME mismatch still accounts usage but writes NO file", async () => {
    const out = path.join(root, "mismatch.mp3");
    const speak: SpeakImpl = async () => speakOk({ mimeType: "audio/wav" }); // != mp3's audio/mpeg
    await withClient({ speak }, async ({ stack }) => {
      await expect(
        _synthesizeSpeech("hi", out, "alloy", "tts-1", "", "mp3", 1, [root], ""),
      ).rejects.toThrow(/provider returned/);
      expect(stack.localCost).toBeCloseTo(0.015); // accounted
      await expect(stat(out)).rejects.toThrow(); // not published
    });
  });

  it("a resolved failure records exactly one unresolved attempt and writes no file", async () => {
    const out = path.join(root, "fail.mp3");
    const speak: SpeakImpl = async () => ({ success: false, error: "no key" });
    await withClient({ speak }, async ({ meter, stack }) => {
      await expect(
        _synthesizeSpeech("hi", out, "alloy", "tts-1", "", "mp3", 1, [root], ""),
      ).rejects.toThrow(/speak failed: no key/);
      expect(meter.snapshot().usage.unknownCostCallCount).toBe(1);
      expect(stack.localCost).toBe(0); // an unresolved attempt bills no money
      await expect(stat(out)).rejects.toThrow();
    });
  });
});

describe("argument validation + preflight (before any paid dispatch)", () => {
  it("rejects an unsupported speak format before dispatch", async () => {
    const speak = vi.fn();
    await withClient({ speak: speak as any }, async ({ meter }) => {
      await expect(
        _synthesizeSpeech(
          "hi",
          path.join(root, "o.mp3"),
          "alloy",
          "tts-1",
          "",
          "bogus",
          1,
          [root],
          "",
        ),
      ).rejects.toThrow(/unsupported format/);
      expect(speak).not.toHaveBeenCalled();
      expect(meter.snapshot().usage.unknownCostCallCount).toBe(0);
    });
  });

  it("rejects an out-of-range / non-finite speak speed before dispatch", async () => {
    const speak = vi.fn();
    await withClient({ speak: speak as any }, async () => {
      await expect(
        _synthesizeSpeech(
          "hi",
          path.join(root, "o.mp3"),
          "alloy",
          "tts-1",
          "",
          "mp3",
          9,
          [root],
          "",
        ),
      ).rejects.toThrow(/speed/);
      await expect(
        _synthesizeSpeech(
          "hi",
          path.join(root, "o2.mp3"),
          "alloy",
          "tts-1",
          "",
          "mp3",
          NaN,
          [root],
          "",
        ),
      ).rejects.toThrow(/speed/);
      expect(speak).not.toHaveBeenCalled();
    });
  });

  it("normalizes format case + a leading dot (a valid call still dispatches)", async () => {
    let seenFormat: string | undefined;
    const speak: SpeakImpl = async (_t, config) => {
      seenFormat = config.format;
      return speakOk();
    };
    await withClient({ speak }, async () => {
      const out = await _synthesizeSpeech("hi", "", "alloy", "tts-1", "", ".MP3", 1, [root], "");
      expect(seenFormat).toBe("mp3");
      expect(out.endsWith(".mp3")).toBe(true);
    });
  });

  it("rejects an invalid transcribe timestampGranularity before dispatch", async () => {
    const filepath = await makeAudioFile();
    const transcribe = vi.fn();
    await withClient({ transcribe: transcribe as any }, async ({ meter }) => {
      await expect(
        _transcribe(filepath, "", [root], "whisper-1", "", "", "bogus", ""),
      ).rejects.toThrow(/timestampGranularity/);
      expect(transcribe).not.toHaveBeenCalled();
      expect(meter.snapshot().usage.unknownCostCallCount).toBe(0);
    });
  });

  it("refuses a dangling-symlink output target before dispatch (no clobber, no dispatch)", async () => {
    const link = path.join(root, "dangling.mp3");
    await symlink(path.join(root, "does-not-exist"), link);
    const speak = vi.fn();
    await withClient({ speak: speak as any }, async () => {
      await expect(
        _synthesizeSpeech("hi", link, "alloy", "tts-1", "", "mp3", 1, [root], ""),
      ).rejects.toThrow(/symlink/);
      expect(speak).not.toHaveBeenCalled();
    });
  });

  it("refuses an unreadable input file before dispatch (access R_OK)", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses perms
    const filepath = path.join(root, "unreadable.wav");
    await writeFile(filepath, Buffer.from([1, 2, 3]));
    await chmod(filepath, 0o000);
    const transcribe = vi.fn();
    await withClient({ transcribe: transcribe as any }, async ({ meter }) => {
      await expect(
        _transcribe(filepath, "", [root], "whisper-1", "", "", "", ""),
      ).rejects.toThrow();
      expect(transcribe).not.toHaveBeenCalled();
      expect(meter.snapshot().usage.unknownCostCallCount).toBe(0);
    });
    await chmod(filepath, 0o644); // let afterEach rm the temp root
  });
});

describe("publishSpeechOutput", () => {
  it("publishes the exact bytes atomically", async () => {
    const out = path.join(root, "pub.mp3");
    const signal = new AbortController().signal;
    await publishSpeechOutput(out, new Uint8Array([1, 2, 3]), signal);
    expect(new Uint8Array(await readFile(out))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("never clobbers a file that appeared after preflight; target stays intact", async () => {
    const out = path.join(root, "taken.mp3");
    await writeFile(out, Buffer.from([42])); // simulate a racing writer
    const signal = new AbortController().signal;
    await expect(publishSpeechOutput(out, new Uint8Array([1, 2, 3]), signal)).rejects.toThrow();
    // original content preserved, no staging left behind
    expect(new Uint8Array(await readFile(out))).toEqual(new Uint8Array([42]));
    const leftovers = (await import("fs/promises")).readdir(root);
    expect((await leftovers).filter((f) => f.includes(".part"))).toHaveLength(0);
  });

  it("cancellation before commit writes nothing", async () => {
    const out = path.join(root, "cancel.mp3");
    const controller = new AbortController();
    controller.abort(new AgencyCancelledError("stop"));
    await expect(
      publishSpeechOutput(out, new Uint8Array([1, 2, 3]), controller.signal),
    ).rejects.toThrow(/stop/);
    await expect(stat(out)).rejects.toThrow();
  });

  it("a failed stage open (unwritable dir) throws without touching an unowned path", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses perms
    const dir = path.join(root, "ro");
    const { mkdir } = await import("fs/promises");
    await mkdir(dir);
    await chmod(dir, 0o500); // read+execute, no write → open("wx") fails
    const signal = new AbortController().signal;
    await expect(
      publishSpeechOutput(path.join(dir, "x.mp3"), new Uint8Array([1, 2, 3]), signal),
    ).rejects.toThrow();
    await chmod(dir, 0o700); // restore so afterEach can remove it
  });
});
