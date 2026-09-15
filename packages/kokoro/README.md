# @agency-lang/kokoro

Turn text into speech on your own machine with the Kokoro model. You don't need an API key, and your text never leaves your machine.

## Installation

```sh
npm install @agency-lang/kokoro
```

The model runs on your CPU through ONNX Runtime. ONNX Runtime ships prebuilt binaries for macOS, Linux, and Windows, so nothing needs to compile.

Two dependencies ask to run an install script. You can leave both scripts blocked, and pnpm 10 and later blocks them by default.

1. `onnxruntime-node` already bundles its CPU binaries. Its script downloads GPU binaries, which this package does not use.
2. `sharp` installs its binary as an optional dependency. Its script only checks that the binary is there.

## Usage

```ts
import { speak } from "pkg::@agency-lang/kokoro"

node main() {
  handle {
    const path = speak("The build finished. Three tests failed.", "build-report.wav")
    print("Wrote ${path}")
  } with (intr) {
    if (intr.effect == "kokoro::download") {
      return approve()
    }
    if (intr.effect == "kokoro::speak") {
      return approve()
    }
    return reject()
  }
}
```

`speak` writes a WAV file and returns its path. If you leave out the output file, `speak` writes a new file in the temp directory. It never overwrites a file that already exists.

## Interrupts

| Effect | When | Payload |
|---|---|---|
| `kokoro::download` | The first call on a machine without the model | `model`, `sizeBytes`, `source` |
| `kokoro::speak` | Every call, before the file is written | `textLength`, `voice`, `outputFile` |

If your handler rejects `kokoro::download`, download the model ahead of time:

```sh
npx -p @agency-lang/kokoro agency-kokoro pull fp32
```

## Models

| Model | Download | Speed on an Apple Silicon CPU |
|---|---|---|
| `fp32` (default) | 326 MB | 4 minutes of audio in about 60 seconds |
| `q8` | 92 MB | 4 minutes of audio in about 100 seconds |

Both models come from the Hugging Face repo `onnx-community/Kokoro-82M-v1.0-ONNX`. `models.lock.json` pins that repo to one commit and lists a SHA-256 hash for every file. The download checks each file against its hash.

Models are saved in `~/.agency/models/kokoro/<model>/`. To save them somewhere else, set `AGENCY_KOKORO_MODELS_DIR`.

To check the files on disk against their hashes again, run:

```sh
npx -p @agency-lang/kokoro agency-kokoro verify fp32
```

## Voices

`voices()` lists all 28 voices. Each voice speaks American or British English and has a grade from A to F. The grade comes from the [Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md). It rates the quality of the audio the voice was trained on, and how much of that audio there was.

These four voices have the best grades:

| Voice | Grade |
|---|---|
| `af_heart` | A |
| `af_bella` | A- |
| `af_nicole` | B- |
| `bf_emma` | B- |

## Limits

- `text` can be at most 50,000 characters. For longer text, call `speak` several times.
- Speed ranges from 0.5 to 2.
- Output is 16-bit mono WAV at 24,000 Hz.
- This package changes two transformers.js settings for the whole process. It turns off downloading models from the network, and it sets the directory that local models load from. Other code in the same process that uses transformers.js gets these settings too.

## License

ISC. The Kokoro model weights are Apache-2.0.
