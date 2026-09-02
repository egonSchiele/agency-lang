# Untestable Builtins

These stdlib functions produce side effects on the user's system, so CI cannot test them. This document tracks the test cases we want once someone establishes a mocking or sandboxing strategy.

## GitHub (`std::github`)

Everything runs against canned responses; a real repository needs a fixture
account and a live token.

- a 401 from an expired token drops the cached token
- a rate-limit 403 carries the reset headers GitHub sends
- a 422 from an inline review comment on a line outside the diff
- a 406 from `ghPrDiff` on a pull request over the diff size limit
- `gh auth token` resolution on a machine logged in through the keyring

## Clipboard (`std::clipboard`)

- `copy` + `paste` round-trip: copy text, paste it back, verify match
- `paste` when clipboard is empty
- `copy` with multiline text, special characters, unicode

## Screenshot (`std::system`)

- Full screen capture produces a valid image file
- Region capture with valid coordinates produces a cropped image
- Invalid filepath (e.g. non-existent directory) throws an error

## Local Text-to-Speech (`std::speech`, `say`)

`say` speaks text through the operating system's own voice on macOS.

- `say` with default voice and rate
- `say` with a custom voice name
- `say` with a custom rate
- `say` with an empty string should return immediately without shelling out to `say`
- `say` with `outputFile` writes the audio instead of playing it

## Cloud Text-to-Speech (`std::speech`, `speak`)

`speak` sends text to a cloud provider and writes the audio to a file.

- `speak` writes an audio file and returns its path
- `speak` never overwrites an existing output file
- `speak` with an unsupported format or an out-of-range speed throws
- `speak` with a missing API key throws an error

## Microphone Recording (`std::speech`, `record`)

- `record` stops when the user presses Enter
- `record` stops after the silence timeout elapses
- `record` with `silenceTimeout: 0` stops only on Enter

## Speech-to-Text (`std::speech`, `transcribe`)

- `transcribe` with a valid WAV file returns text
- `transcribe` with a language hint
- `transcribe` with a missing API key throws an error
- `transcribe` with an invalid or corrupt audio file throws an error
- `transcribe` with a file that exceeds the provider's size limit
