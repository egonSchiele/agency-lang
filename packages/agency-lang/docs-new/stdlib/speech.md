# speech

## Functions

### speak

```ts
speak(text: string, voice: string, rate: number, outputFile: string)
```

A tool for speaking text aloud using text-to-speech. Optionally specify a voice name, rate in words per minute, and an output file to save the audio to instead of playing it.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/speech.agency#L3))

### transcribe

```ts
transcribe(filepath: string, language: string): string
```

A tool for transcribing an audio file to text using OpenAI's Whisper API. Optionally specify a language code (e.g. "en") for better accuracy.

  @param filepath - Path to the audio file
  @param language - Language code for better accuracy

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filepath | `string` |  |
| language | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/speech.agency#L19))
