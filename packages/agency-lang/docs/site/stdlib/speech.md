# speech

## Functions

### speak

```ts
speak(text: string, voice: string, rate: number, outputFile: string)
```

A tool for speaking text aloud using text-to-speech. Optionally specify a voice name, rate in words per minute, and an output file to save the audio to instead of playing it.

  Cancellation: in-progress speech playback is stopped on Ctrl-C, race-loser, or time-guard abort.

  @param text - The text to speak
  @param voice - Voice name
  @param rate - Words per minute
  @param outputFile - File path to save audio to

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| voice | `string` | "" |
| rate | `number` | 0 |
| outputFile | `string` | "" |

**Throws:** `std::speak`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/speech.agency#L7))

### record

```ts
record(outputFile: string, silenceTimeout: number): string
```

Record audio from the microphone. Stops when the user presses Enter,
  or after the specified silence timeout. Set silenceTimeout to 0 to
  disable silence detection (recording stops only on Enter).

  The silenceTimeout parameter is in milliseconds, so you can use
  Agency's unit literals: record(silenceTimeout: 3s), record(silenceTimeout: 500ms).
  Set to 0 for no timeout.

  Cancellation: an in-progress recording is stopped on Ctrl-C, race-loser, or time-guard abort, surfacing as an AgencyCancelledError.

  @param outputFile - File path to save audio to (auto-generated if empty)
  @param silenceTimeout - Silence before auto-stopping in ms (0 to disable)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| outputFile | `string` | "" |
| silenceTimeout | `number` | 2000 |

**Returns:** `string`

**Throws:** `std::record`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/speech.agency#L25))

### transcribe

```ts
transcribe(filepath: string, language: string): string
```

A tool for transcribing an audio file to text using OpenAI's Whisper API. Optionally specify a language code (e.g. "en") for better accuracy.

  Cancellation: an in-flight Whisper upload tears down on Ctrl-C, race-loser, or time-guard abort.

  @param filepath - Path to the audio file
  @param language - Language code for better accuracy

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filepath | `string` |  |
| language | `string` | "" |

**Returns:** `string`

**Throws:** `std::transcribe`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/speech.agency#L45))
