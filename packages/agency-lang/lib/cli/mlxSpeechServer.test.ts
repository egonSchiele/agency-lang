import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { MLX_AUDIO_VERSION, speechServerScript } from "./localServe.js";

const rulesModule = path.join(path.dirname(speechServerScript()), "mlxSpeechRules.py");

// Every test here calls into Python, so the whole block skips once when
// there is no python3, instead of each test guarding itself.
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

/** Runs `code` with the rules module importable, and returns stdout. */
function rules(code: string): string {
  const run = spawnSync(
    "python3",
    [
      "-c",
      `import sys; sys.path.insert(0, sys.argv[1]); from mlxSpeechRules import *\n${code}`,
      path.dirname(rulesModule),
    ],
    // No __pycache__ next to the source.
    { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.status).toBe(0);
  return run.stdout.toString().trim();
}

const CUSTOM = { model_type: "qwen3_tts", tts_model_type: "custom_voice" };
const DESIGN = { model_type: "qwen3_tts", tts_model_type: "voice_design" };
const SPEAKERS = ["serena", "vivian", "ryan"];

/** Runs check_request and prints either the result or the error message. */
function check(family: string, body: Record<string, unknown>): string {
  return rules(`
import json
try:
    print(json.dumps(check_request(${JSON.stringify(family)}, ${JSON.stringify(SPEAKERS)}, ${JSON.stringify(body)}), sort_keys=True))
except RequestError as err:
    print("ERROR", err.status, err)
`);
}

describe.skipIf(!hasPython3)("mlxSpeechRules.py", () => {
  it("ships next to localServe", () => {
    expect(fs.existsSync(rulesModule)).toBe(true);
  });

  it("imports nothing from mlx, so CI can run it", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).not.toMatch(/^\s*(import|from)\s+mlx/m);
  });

  it("names the family from config.json, and refuses the rest", () => {
    const out = rules(`
print(family_of(${JSON.stringify(CUSTOM)}))
print(family_of(${JSON.stringify(DESIGN)}))
print(family_of({"model_type": "llama"}))
try:
    family_of({"model_type": "chatterbox"})
except RequestError as err:
    print(err)
`);
    expect(out.split("\n")).toEqual([
      "custom_voice",
      "voice_design",
      "orpheus",
      'mlxSpeechServer.py serves Qwen3-TTS (CustomVoice or VoiceDesign) models. This model has model_type "chatterbox".',
    ]);
  });

  it("a CustomVoice request gets the default speaker, accepts instructions, and refuses an unknown speaker", () => {
    const ok = check("custom_voice", { input: "Hello there.", instructions: "Calm." });
    expect(JSON.parse(ok)).toEqual({
      text: "Hello there.",
      voice: "ryan",
      instructions: "Calm.",
      format: "wav",
    });
    expect(JSON.parse(check("custom_voice", { input: "Hi.", voice: "Ryan" })).voice).toBe("ryan");
    expect(check("custom_voice", { input: "Hi.", voice: "alloy" })).toBe(
      'ERROR 400 "alloy" is not a voice of this model. Its voices are serena, vivian, and ryan.',
    );
  });

  it("joins two names without a comma", () => {
    expect(rules(`print(join_names(["serena", "ryan"]))`)).toBe("serena and ryan");
  });

  it("a VoiceDesign request needs instructions and takes no voice", () => {
    expect(
      JSON.parse(check("voice_design", { input: "Hi.", instructions: "A deep, slow voice." })),
    ).toEqual({
      format: "wav",
      instructions: "A deep, slow voice.",
      text: "Hi.",
      voice: "",
    });
    expect(check("voice_design", { input: "Hi." })).toBe(
      'ERROR 400 This VoiceDesign model needs instructions describing the voice, such as "A deep, slow voice."',
    );
    expect(check("voice_design", { input: "Hi.", instructions: "Deep.", voice: "ryan" })).toBe(
      "ERROR 400 This VoiceDesign model has no preset voices. Leave voice empty and describe the voice in instructions.",
    );
  });

  it("refuses a format other than wav or pcm, a speed other than 1, and empty or long text", () => {
    expect(check("custom_voice", { input: "Hi.", response_format: "mp3" })).toBe(
      'ERROR 400 response_format "mp3" is not supported. Use wav or pcm.',
    );
    expect(check("custom_voice", { input: "Hi.", speed: 1.5 })).toBe(
      "ERROR 400 Local speech models do not support a speed other than 1.",
    );
    expect(check("custom_voice", { input: "" })).toBe(
      "ERROR 400 input must be a non-empty string.",
    );
    expect(check("custom_voice", { input: "x".repeat(1001) })).toBe(
      "ERROR 400 input is 1001 characters; this server takes at most 1000 per request.",
    );
  });

  it("splits text into sentences, keeps an abbreviation with what follows, and drops empty parts", () => {
    const out = rules(`
import json
print(json.dumps(split_sentences("Stop!  Don't touch that wire. It's live.\\n\\nReally.")))
print(json.dumps(split_sentences("no punctuation at all")))
print(json.dumps(split_sentences("你好。今天怎么样？")))
print(json.dumps(split_sentences("Mr. Smith is here. Ask Dr. Lee, e.g. now.")))
`);
    expect(out.split("\n").map((line) => JSON.parse(line))).toEqual([
      ["Stop!", "Don't touch that wire.", "It's live.", "Really."],
      ["no punctuation at all"],
      ["你好。", "今天怎么样？"],
      ["Mr. Smith is here.", "Ask Dr. Lee, e.g. now."],
    ]);
  });

  it("builds the warm-up request from the family's row", () => {
    const out = rules(`
import json
print(json.dumps(warm_up_request("custom_voice"), sort_keys=True))
print(json.dumps(warm_up_request("voice_design"), sort_keys=True))
`);
    expect(out.split("\n")).toEqual([
      '{"input": "Ready.", "response_format": "wav"}',
      '{"input": "Ready.", "instructions": "A calm, clear voice.", "response_format": "wav"}',
    ]);
  });

  it("pins the same mlx-audio version as localServe.ts", () => {
    const text = fs.readFileSync(rulesModule, "utf8");
    expect(text).toContain(`MLX_AUDIO_VERSION = "${MLX_AUDIO_VERSION}"`);
  });
});

describe.skipIf(!hasPython3)("mlxSpeechServer.py", () => {
  it("ships next to localServe", () => {
    const script = speechServerScript();
    expect(script.endsWith("/lib/cli/mlxSpeechServer.py")).toBe(true);
    expect(fs.existsSync(script)).toBe(true);
  });

  // A syntax check only. Running the server needs MLX, which CI has not.
  it("is valid Python 3", () => {
    const run = spawnSync(
      "python3",
      ["-c", "import ast, sys; ast.parse(open(sys.argv[1]).read())", speechServerScript()],
      { stdio: "pipe" },
    );
    expect(run.stderr.toString()).toBe("");
    expect(run.status).toBe(0);
  });
});
