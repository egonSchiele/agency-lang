---
name: "speech"
description: "Speak text aloud locally, synthesize and transcribe speech in the cloud, and record from the microphone."
---

# speech

Speak text aloud locally, synthesize and transcribe speech in the
cloud, and record from the microphone.

  ```ts
  import { record, transcribe, speak, say } from "std::speech"

  node main() {
    const audio = record()
    const text = transcribe(audio)
    say("You said: ${text}")             // local playback
    const mp3 = speak("Cloud voice: ${text}")  // cloud TTS -> file path
  }
  ```

## Effects

### std::say

```ts
effect std::say {
  textLength: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L34))

### std::record

```ts
effect std::record {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L35))

### std::transcribe

```ts
effect std::transcribe {
  requestedProvider: string;
  configuredModel: string;
  filepath: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L40))

### std::synthesizeSpeech

```ts
effect std::synthesizeSpeech {
  requestedProvider: string;
  configuredModel: string;
  textLength: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L47))

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

Speak text aloud locally using the operating system's text-to-speech
  (macOS only). For cloud text-to-speech that returns an audio file, use
  `speak()` instead.

  @param text - The text to speak
  @param voice - Voice name to use
  @param rate - Speaking rate in words per minute
  @param outputFile - When set, save the audio to this file instead of playing it
  @param allowedPaths - Only allow saving under these path prefixes

Ctrl-C, a race loss, or a time-guard abort stops in-progress speech
playback.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| voice | `string` | "" |
| rate | `number` | 0 |
| outputFile | `string` | "" |
| allowedPaths | `string[]` | [] |

**Throws:** `std::say`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L55))

### record

```ts
record(
  outputFile: string = "",
  silenceTimeout: number = 2000,
  allowedPaths: string[] = [],
): string
```

Record audio from the microphone. Recording stops when the user presses Enter, or after the silence timeout elapses.

  @param outputFile - File path to save audio to (auto-generated in the temp directory if empty)
  @param silenceTimeout - Silence before auto-stopping, in milliseconds; 0 disables silence detection so recording stops only on Enter
  @param allowedPaths - Only allow saving a non-empty outputFile under these path prefixes

* `silenceTimeout` is in milliseconds, so you can pass Agency's unit literals:
 * `record(silenceTimeout: 3s)`, `record(silenceTimeout: 500ms)`.
 *
 * Ctrl-C, a race loss, or a time-guard abort stops an in-progress recording,
 * which surfaces as an AgencyCancelledError.
 *
 * An empty `outputFile` is auto-generated under the system temp directory and
 * is not subject to the `allowedPaths` allow-list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| outputFile | `string` | "" |
| silenceTimeout | `number` | 2000 |
| allowedPaths | `string[]` | [] |

**Returns:** `string`

**Throws:** `std::record`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L90))

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

  @param filepath - Path to the audio file
  @param language - Language code (e.g. "en") for better accuracy
  @param allowedPaths - Only allow reading audio files under these path prefixes
  @param model - Transcription model (default "whisper-1")
  @param provider - Override the provider (normally derived from the model name)
  @param prompt - Optional text to bias decoding (names, jargon)
  @param timestampGranularity - "segment" or "word" to request timestamps
  @param apiKey - Override the API key

A cloud transcription request tears down on Ctrl-C, race-loser, or
time-guard abort. Cost, spend guards, and statelog apply.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filepath | `string` |  |
| language | `string` | "" |
| allowedPaths | `string[]` | [] |
| model | `string` | "whisper-1" |
| provider | `string` | "" |
| prompt | `string` | "" |
| timestampGranularity | `string` | "" |
| apiKey | `string` | "" |

**Returns:** `string`

**Throws:** `std::transcribe`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L105))

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
): string
```

Synthesize speech from text using a cloud text-to-speech provider (OpenAI
  by default), writing the audio to a file and returning its path. For local
  playback through the speakers, use `say()` instead.

  @param text - The text to synthesize
  @param outputFile - Where to write the audio (auto-generated temp file if empty). Never overwrites an existing file.
  @param voice - Voice name (default "alloy")
  @param model - Speech model (default "tts-1")
  @param provider - Override the provider (normally derived from the model name)
  @param format - Output audio format: mp3 (default), opus, aac, flac, wav, or pcm
  @param speed - Speaking speed (0.25 to 4.0)
  @param allowedPaths - Only allow writing a non-empty outputFile under these path prefixes
  @param apiKey - Override the API key

A cloud synthesis request tears down on Ctrl-C, race-loser, or time-guard
abort; a cancelled request never writes its output file. Cost, spend guards,
and statelog apply.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| outputFile | `string` | "" |
| voice | `string` | "alloy" |
| model | `string` | "tts-1" |
| provider | `string` | "" |
| format | `string` | "mp3" |
| speed | `number` | 1 |
| allowedPaths | `string[]` | [] |
| apiKey | `string` | "" |

**Returns:** `string`

**Throws:** `std::synthesizeSpeech`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L153))
