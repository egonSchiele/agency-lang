# @agency-lang/kokoro: developer notes

The code map, and the things that are easy to break.

## Files

| File | What it holds |
|---|---|
| `index.agency` | `speak` and `voices`, and the two interrupts |
| `src/agency.ts` | The functions `index.agency` calls. `_download` and `_speak` read the abort signal from the runtime |
| `src/speak.ts` | `speakWith`: pick the output file, refuse an existing one, synthesize, encode, publish |
| `src/kokoroModel.ts` | Loading the model, keeping one loaded, running calls one at a time, synthesizing a sentence at a time |
| `src/textChunks.ts` | `sentenceWindows` and `splitToFit`, which cut text into pieces that kokoro-js and the model can handle |
| `src/wav.ts` | `toPcm16` and `encodeWav`, 16-bit PCM |
| `src/modelStore.ts` | Where models live, whether one is installed, and downloading one |
| `src/lockfile.ts` | The pinned lockfile, and the download snapshot for a model |
| `src/argumentChecks.ts` | The checks that run before any interrupt |
| `src/voices.ts` | The voice table |
| `src/processListeners.ts`, `src/listenersBefore.ts`, `src/listenersAfter.ts` | Removing phonemizer's process listeners |
| `src/cli.ts` | `agency-kokoro pull` and `verify` |

## Interrupts

`speak` raises `kokoro::download` only when the model is missing, and calls `_download` on the next line. Approval resumes on that line, so the download runs only after a yes. Cancelling the run stops the download. `_speak` never downloads. It refuses to run when the model is missing.

`speak` then raises `kokoro::speak`, whose payload names the real output path. `_speak` checks that path again with `outputPath` and `pathExists` from `agency-lang/stdlib-lib/speech.js`. Those two refuse a symlink that appeared while the prompt was open.

## Five problems in kokoro-js 1.2.1

`kokoro-js` is pinned exactly, because the code below depends on how 1.2.1 behaves.

1. **`generate()` silently truncates.** Kokoro reads at most 510 phoneme tokens. `splitToFit` cuts every sentence to at most 250 characters. The integration test fails if a 40-sentence passage comes out under 200 seconds.
2. **`stream()` with a string never finishes.** It never closes its splitter. The package does not use `stream()`. It iterates the splitter synchronously and calls `generate()` once per piece.
3. **`RawAudio.save()` writes float samples.** `encodeWav` writes 16-bit PCM instead.
4. **Importing kokoro-js adds process listeners.** phonemizer's WebAssembly build adds `uncaughtException` and `unhandledRejection` listeners that rethrow. They crash a host program that handles those events itself. `kokoroModel.ts` imports `listenersBefore.js`, then kokoro-js, then `listenersAfter.js`, which removes whatever was added. Keep that order, and keep `kokoroModel.ts` the only module that imports kokoro-js. `tests/kokoroModel.test.ts` fails if a listener survives.
5. **`TextSplitterStream` is slow on long text.** Its work grows with the square of the text it holds. `sentenceWindows` cuts text between sentences into windows of at most 1,000 characters, and `textPieces` gives each window its own splitter. `tests/kokoroModel.test.ts` fails if splitting a long run of punctuation takes more than a few seconds.

## Memory

`synthesize` converts each sentence's audio to 16-bit samples as soon as the model returns it, and `encodeWav` copies those samples into the file's bytes once. The whole file is in memory before it is written, so `speak` refuses text over 50,000 characters.

## Models on disk

Each model has its own directory: `<modelsDir>/<model>/onnx-community/Kokoro-82M-v1.0-ONNX/`. The downloader's record, `.agency-model.json`, lists only the files of the last snapshot fetched into a directory. Two models sharing a directory would each erase the other from the record.

`downloadHubSnapshot` from agency-lang does the download, from a snapshot built from `models.lock.json`. It never asks the Hub for the file list. Every lockfile entry has a `sha256`, so the downloader hashes every file, including the small JSON files.

`modelStatus` checks the record and the size of each file on disk. It does not hash the files. `agency-kokoro verify` does.

The package imports `env` from `@huggingface/transformers` directly, because kokoro-js's own `env` export only wraps `wasmPaths`. Keep `@huggingface/transformers` pinned to the version kokoro-js resolves, so both load the same copy.

## Tests

| File | Needs |
|---|---|
| `wav`, `textChunks`, `argumentChecks`, `lockfile`, `modelStore` | Nothing |
| `kokoroModel` | kokoro-js installed. No model |
| `speak` | A fake `KokoroTTS`. No model |
| `reject` | `make`, because it runs `tests/agency/reject.agency` with the agency CLI |
| `integration` | `AGENCY_RUN_SLOW=1` and the `fp32` model, from `agency-kokoro pull fp32` |

Tests delete temp directories only through `tests/tempDir.ts`, which refuses anything not directly under the temp directory.

## Updating kokoro-js

1. Check whether problems 2, 4, and 5 above still exist. The tests catch problems 4 and 5.
2. Compare the voice table. The integration test compares `VOICES` with the loaded model's table.
3. Pin `@huggingface/transformers` to the version the new kokoro-js resolves.
