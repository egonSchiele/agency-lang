# Untestable Builtins

These stdlib functions produce side effects on the user's system and cannot be tested in CI. This document tracks the desired test cases for future implementation when a mocking/sandboxing strategy is established.

## Clipboard (`std::clipboard`)

- `copy` + `paste` round-trip: copy text, paste it back, verify match
- `paste` when clipboard is empty
- `copy` with multiline text, special characters, unicode

## Screenshot (`std::system`)

- Full screen capture produces a valid image file
- Region capture with valid coordinates produces a cropped image
- Invalid filepath (e.g. non-existent directory) throws an error

## Text-to-Speech (`std::speech`)

- `speak` with default voice and rate
- `speak` with custom voice name
- `speak` with custom rate
- `speak` with empty string should return immediately without calling `say`

## Speech-to-Text (`std::speech`)

- `transcribe` with a valid WAV file returns text
- `transcribe` with language hint
- `transcribe` with missing API key throws an error
- `transcribe` with invalid/corrupt audio file throws an error
- `transcribe` with file exceeding 25 MB limit
