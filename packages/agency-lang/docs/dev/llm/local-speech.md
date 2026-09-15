# Local speech serving

This command starts a speech server on this Mac:

    agency local serve --speech qwen3-tts-mlx

Each `--speech` model gets its own process running
`lib/cli/mlxSpeechServer.py`. The process sits behind the same front door
as chat and embedding processes. It answers `POST /v1/audio/speech` in the
OpenAI shape:

    curl -s http://127.0.0.1:8080/v1/audio/speech \
      -H 'content-type: application/json' \
      -d '{"model": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "input": "Hello there.", "instructions": "Calm."}' \
      -o hello.wav

A success is the audio bytes. A failure is `{"error": {"message": "..."}}`.

## Why Agency ships its own script

mlx-audio comes with a server, `mlx_audio.server`. Agency does not use it,
for two reasons:

1. It drops request fields it does not list, so `instructions` never
   reaches the model.
2. It defaults `lang_code` to `"a"` instead of detecting the language.

With its own script, Agency defines the request fields in one place. The
script refuses anything a model cannot use, and says why.

## The two files

`lib/cli/mlxSpeechRules.py` holds the request rules: which model families
are served, which voice and instructions each takes, the formats, the text
limit, and the sentence split. It imports nothing from MLX.
`lib/cli/mlxSpeechServer.test.ts` runs these rules in CI through `python3`,
since CI has no MLX.

`lib/cli/mlxSpeechServer.py` loads the model with mlx-audio and serves
requests. It needs a Mac. The Makefile copies both files into `dist`.

## Families

The server reads the model's `config.json` to find its family:

| `model_type` | `tts_model_type` | Family | Voice | Instructions |
|---|---|---|---|---|
| `qwen3_tts` | `custom_voice` | CustomVoice | one of the model's nine speakers; `ryan` by default | optional |
| `qwen3_tts` | `voice_design` | VoiceDesign | none | required: they describe the voice |
| `qwen3_tts` | `base` | refused | | |
| `llama` | | Orpheus, refused for now | | |

A Base model needs a reference recording, which this server does not take.
Orpheus gets a row in a later change.

Each family is one row in the `FAMILIES` table in the rules module.
`check_request` reads the row, so adding a family means adding a row.

## Refusing instead of ignoring

A request the model cannot honour gets a 400 that names what it takes:

    "alloy" is not a voice of this model. Its voices are serena, vivian, ...

The same goes for a `speed` other than 1, which no family supports, and a
`response_format` other than `wav` or `pcm`. A model calling the speech
function as a tool reads the message and can fix its next call. A silently
ignored field would give it audio that does not match what it asked for.

Voice names compare in lowercase, because the model lowercases the name it
is given.

## Sentences

The server splits the input into sentences and calls `generate` once per
sentence. It splits after `.`, `!`, and `?` when whitespace follows, and
after the full-width `。`, `！`, and `？` with or without whitespace. A known
abbreviation such as `Mr.` or `e.g.` does not end a sentence. Splitting
means a long paragraph on one line is never cut off by the per-generation
token limit.

One request takes at most 1,000 characters. A long generation holds the
lock that keeps MLX to one computation at a time, and the limit bounds how
long one caller can hold it.

## The version pin

The server refuses to start under any mlx-audio other than 0.5.4. It reads
the installed version from the package metadata with
`importlib.metadata.version("mlx-audio")`, because mlx-audio 0.5.4 does not
set `mlx_audio.__version__`. `MLX_AUDIO_VERSION` in `localServe.ts` gives
the same version to the pip line in the "cannot import mlx_audio" message.
A test checks that the two constants match.

mlx-audio 0.5.4 needs mlx 0.31.1 or newer, which ships wheels for macOS 14
and later only.

## Readiness

The script loads the model, then generates one short sentence with its
family's defaults, and only then opens its port. `waitUntilLoaded` probes a
speech process with `GET /health`. A refused connection means it is still
loading. Any answer means it can speak.

A model that loads but cannot generate exits during that warm-up, and
`serve` reports "the speech server for X exited with 1 before it was
ready". The TypeScript side never needs to know that VoiceDesign wants
instructions. That rule lives only in the Python rules module.

`checkPython` imports only the modules the planned kinds need: `mlx_lm` for
chat and embedding models, `mlx_audio` for speech models.

## The log

The front door logs an audio reply as a byte count, taken from
`Capture.total`:

    POST /v1/audio/speech  mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit  200  15.4s  318,764 bytes of audio

Any `audio/*` or `application/octet-stream` reply counts as audio. With
`--log-prompts`, the request body is still printed, and the audio bytes are
not.

When a process is unreachable, the door's 502 names it with `Route.label`,
for example "the speech server for X".

## Cancellation

A sentence that is already generating cannot be stopped. When the client
hangs up, the front door closes its connection to the speech process. The
script checks that connection before each sentence and stops there. It
then writes nothing, since nobody is listening.
