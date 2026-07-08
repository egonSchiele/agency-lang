---
name: "speech"
---

# speech

Speak text aloud, record from the microphone, and transcribe audio
to text.

  ```ts
  import { record, transcribe, speak } from "std::speech"

  node main() {
    const audio = record()
    const text = transcribe(audio)
    speak("You said: ${text}")
  }
  ```

## Effects

### std::speak

```ts
effect std::speak {
  textLength: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L28))

### std::record

```ts
effect std::record {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L29))

### std::transcribe

```ts
effect std::transcribe {
  filepath: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L30))

## Functions

### speak

```ts
speak(text: string, voice: string, rate: number, outputFile: string, allowedPaths: string[])
```

Speak text aloud using text-to-speech.

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

**Throws:** `std::speak`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L34))

### record

```ts
record(outputFile: string, silenceTimeout: number, allowedPaths: string[]): string
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L61))

### transcribe

```ts
transcribe(filepath: string, language: string, allowedPaths: string[]): string
```

Transcribe an audio file to text using OpenAI's Whisper API.

  @param filepath - Path to the audio file
  @param language - Language code (e.g. "en") for better accuracy
  @param allowedPaths - Only allow reading audio files under these path prefixes

An in-flight Whisper upload tears down on Ctrl-C, race-loser, or time-guard
abort.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filepath | `string` |  |
| language | `string` | "" |
| allowedPaths | `string[]` | [] |

**Returns:** `string`

**Throws:** `std::transcribe`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/speech.agency#L76))
