---
name: "speech"
description: "Speak text aloud locally, synthesize and transcribe speech in the cloud, and record from the microphone."
---

# speech

Speak text aloud locally, synthesize and transcribe speech in the
cloud, and record from the microphone.

  ```ts
  import { record, transcribe, speak, speakLocal, say } from "std::speech"

  node main() {
    const audio = record()
    const text = transcribe(audio)
    say("You said: ${text}")             // local playback
    const mp3 = speak("Cloud voice: ${text}")  // cloud TTS -> file path
    const wav = speakLocal("Local voice: ${text}", "qwen3-tts-mlx")  // local TTS -> file path
  }
  ```

## Effects

### std::say

```ts
effect std::say {
  textLength: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L40))

### std::record

```ts
effect std::record {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L41))

### std::transcribe

```ts
effect std::transcribe {
  requestedProvider: string;
  configuredModel: string;
  filepath: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L46))

### std::synthesizeSpeech

```ts
effect std::synthesizeSpeech {
  requestedProvider: string;
  configuredModel: string;
  textLength: number;
  instructions: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L53))

### std::localSpeech

```ts
effect std::localSpeech {
  model: string;
  voice: string;
  textLength: number;
  outputFile: string;
  format: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L63))

## Functions

### say

```ts
say(
  text: string,
  voice: string = "",
  rate: number = 0,
  outputFile: string = "",
  allowedPaths: string[] = [],
)
```

Speak text aloud using macOS text-to-speech.

Ctrl-C, a race loss, or a time-guard abort stops in-progress playback.
Use `speak` for cloud synthesis or `speakLocal` for a local model that writes audio.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| text | `string` |  |  |
| voice | `string` | "" | macOS voice name, or empty for the default. |
| rate | `number` | 0 | Words per minute, or zero for the default. |
| outputFile | `string` | "" | Save audio here instead of playing it when nonempty. |
| allowedPaths | `string[]` | [] | Restrict outputFile to these directories, or leave empty for no restriction. |

**Throws:** `std::say`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L92))

### record

```ts
record(
  outputFile: string = "",
  silenceTimeout: number = 2000,
  allowedPaths: string[] = [],
): string
```

Record audio from the microphone. Recording stops when the user presses Enter, or after the silence timeout elapses.

`silenceTimeout` is in milliseconds, so you can pass Agency's unit literals:
  `record(silenceTimeout: 3s)`, `record(silenceTimeout: 500ms)`.

  Ctrl-C, a race loss, or a time-guard abort stops an in-progress recording,
  which surfaces as an AgencyCancelledError.

  An empty `outputFile` is auto-generated under the system temp directory and
  is not subject to the `allowedPaths` allow-list.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| outputFile | `string` | "" | File path to save audio to (auto-generated in the temp directory if empty) |
| silenceTimeout | `number` | 2000 | Silence before auto-stopping, in milliseconds; 0 disables silence detection so recording stops only on Enter |
| allowedPaths | `string[]` | [] | Only allow saving a non-empty outputFile under these path prefixes |

**Returns:** `string`

**Throws:** `std::record`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L127))

### transcribe

```ts
transcribe(
  filepath: string,
  language: string = "",
  allowedPaths: string[] = [],
  model: string = "whisper-1",
  provider: string = "",
  prompt: string = "",
  timestampGranularity: string = "",
  apiKey: string = "",
): string
```

Transcribe an audio file to text using a cloud speech provider (OpenAI
  Whisper by default). Returns the transcript text; throws on failure.

Transcription uses the active model client and counts toward usage.
Cancellation stops the request. Even when timestampGranularity is supplied,
this function returns only the transcript text.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filepath | `string` |  |  |
| language | `string` | "" | Language code (e.g. "en") for better accuracy |
| allowedPaths | `string[]` | [] | Only allow reading audio files under these path prefixes |
| model | `string` | "whisper-1" |  |
| provider | `string` | "" | Override the provider (normally derived from the model name) |
| prompt | `string` | "" | Optional text to bias decoding (names, jargon) |
| timestampGranularity | `string` | "" | "segment" or "word". The result is still plain text without timestamps. |
| apiKey | `string` | "" | Override the API key |

**Returns:** `string`

**Throws:** `std::transcribe`

**Needs:** `fileRead`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L147))

### speak

```ts
speak(
  text: string,
  outputFile: string = "",
  voice: string = "alloy",
  model: string = "tts-1",
  provider: string = "",
  format: string = "mp3",
  speed: number = 1,
  allowedPaths: string[] = [],
  apiKey: string = "",
  instructions: string = "",
): string
```

Synthesize speech from text using a cloud text-to-speech provider (OpenAI
  by default), writing the audio to a file and returning its path. For local
  playback through the speakers, use `say()` instead.

A cloud synthesis request tears down on Ctrl-C, race-loser, or time-guard
abort; a cancelled request never writes its output file. Cost, spend guards,
and statelog apply.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| text | `string` |  |  |
| outputFile | `string` | "" | Where to write the audio (auto-generated temp file if empty). Never overwrites an existing file. |
| voice | `string` | "alloy" |  |
| model | `string` | "tts-1" |  |
| provider | `string` | "" | Override the provider (normally derived from the model name) |
| format | `string` | "mp3" | Output audio format: mp3 (default), opus, aac, flac, wav, or pcm |
| speed | `number` | 1 | Speaking speed (0.25 to 4.0) |
| allowedPaths | `string[]` | [] | Only allow writing a non-empty outputFile under these path prefixes |
| apiKey | `string` | "" | Override the API key |
| instructions | `string` | "" | How the speech should sound, in plain words: "Calm and slow." Needs a model that reads it, such as gpt-4o-mini-tts; tts-1 and tts-1-hd ignore it |

**Returns:** `string`

**Throws:** `std::synthesizeSpeech`

**Needs:** `fileRead`, `fileWrite`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L199))

### speakLocal

```ts
speakLocal(
  text: string,
  model: string,
  voice: string = "",
  instructions: string = "",
  outputFile: string = "",
  format: string = "",
  allowedPaths: string[] = [],
  speed: number = 1,
): string raises <std::localSpeech>
```

Speak text into an audio file with a local speech model, and return the path of that file.

Use this to generate speech locally. Long text is sent in pieces, so
Ctrl-C stops within one piece and writes no file. The run records one
usage event per call with zero provider cost.

Writing mp3 or m4a, or a speed other than 1, needs `ffmpeg` on the PATH.
`speakLocal` refuses such a call before raising any interrupt when
`ffmpeg` is missing. The local models cannot change their own speed, so
`speed` stretches the audio after it is generated, keeping its pitch.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| text | `string` |  | The text to speak. Orpheus models perform emotion tags written in the text, such as `<laugh>`, `<sigh>`, or `<gasp>`. |
| model | `string` |  | The speech model: a catalog name such as "qwen3-tts-mlx" or "orpheus-3b-mlx", an mlx: URI, or a repo id the server is serving. |
| voice | `string` | "" | A voice of that model. Leave empty for the model's default. VoiceDesign models take no voice. |
| instructions | `string` | "" | How the speech should sound, such as "Alarmed and urgent". Qwen3-TTS models only; Orpheus takes tags in the text instead. |
| outputFile | `string` | "" | Where to write the file. Leave empty for a new temp file. An existing file is never overwritten. |
| format | `string` | "" | "wav", "mp3", "m4a", or "pcm". Leave empty to use the output file's extension, or wav when there is none. A format you give wins over the extension. |
| allowedPaths | `string[]` | [] | Directories that outputFile must be inside |
| speed | `number` | 1 | Speaking speed, from 0.5 to 100 (both included). Anything other than 1 needs ffmpeg. |

**Returns:** `string`

**Throws:** `std::localSpeech`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L264))
