# @agency-lang/kokoro

Local text-to-speech for Agency with the Kokoro model. No API key, and no text leaves your machine.

## Installation

```sh
npm install @agency-lang/kokoro
```

There is no compiler and no native build. The model runs on the CPU through ONNX Runtime, which ships prebuilt binaries for macOS, Linux, and Windows.

Two dependencies ask to run an install script: `onnxruntime-node` and `sharp`. Both can stay blocked, and pnpm 10 or later blocks them by default:

1. `onnxruntime-node` already bundles its CPU binaries. Its script only downloads the CUDA GPU binaries, which this package does not use.
2. `sharp` gets its binary as an optional dependency. Its script only checks that the binary is there.

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

`speak` writes a WAV file and returns its path. An empty `outputFile` writes a new file in the temp directory. It never overwrites an existing file.

## Interrupts

| Effect | When | Payload |
|---|---|---|
| `kokoro::download` | The first call on a machine without the model | `model`, `sizeBytes`, `source` |
| `kokoro::speak` | Every call, before the file is written | `textLength`, `voice`, `outputFile` |

A handler that approves only `kokoro::speak` rejects the download. Such a program works once the model is downloaded ahead of time:

```sh
npx -p @agency-lang/kokoro agency-kokoro pull fp32
```

## Models

| Model | Download | Speed on an Apple Silicon CPU |
|---|---|---|
| `fp32` (default) | 326 MB | 4 minutes of audio in about 60 seconds |
| `q8` | 92 MB | 4 minutes of audio in about 100 seconds |

Files come from the Hugging Face repo `onnx-community/Kokoro-82M-v1.0-ONNX`, pinned to one commit in `models.lock.json`. Every file is checked against its SHA-256. Models live in `~/.agency/models/kokoro/<model>/`. Set `AGENCY_KOKORO_MODELS_DIR` to use another directory.

`agency-kokoro verify <model>` hashes the files on disk against the lockfile.

## Voices

`voices()` lists all 28 voices, American and British English, with a quality grade from A to F. The best are `af_heart` (A), `af_bella` (A-), `af_nicole` (B-), and `bf_emma` (B-).

## Things to know

- **The package sets transformers.js's global `env`.** It turns off remote model loading and points the local model path at the Kokoro directory. Other code in the same process that uses transformers.js sees these settings.
- **Output is 16-bit mono WAV at 24,000 Hz.** Convert it yourself if you need another format.
- **Speed ranges from 0.5 to 2.**

## License

ISC. The Kokoro model weights are Apache-2.0.
