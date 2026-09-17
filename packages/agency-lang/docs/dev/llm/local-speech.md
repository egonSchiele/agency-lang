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

## Never run mlx_audio.server

There is a third reason, found later: `mlx_audio.server` lets any web page
you visit run code on your machine, for as long as that server is running.

The endpoints that change state take their parameters in the query string
and require no authentication, so an ordinary HTML form on any site can
post to `http://127.0.0.1:8000/v1/models?model_name=attacker/evil-model`.
A form post is a CORS simple request, so the browser sends it without a
preflight and the server's origin allowlist is never consulted. The attack
never reads the reply; downloading and loading the named model is the
payload. Several loaders then call `AutoTokenizer.from_pretrained` with
`trust_remote_code=True`, so the attacker's repository executes Python as
you, with your environment: `HF_TOKEN`, SSH keys, everything.

Tightening `MLX_AUDIO_ALLOWED_ORIGINS` does not help. CORS decides who may
read a reply, not whose request reaches the handler.

Agency is clear of this, and these are the properties that keep it clear.
Check them before changing anything in this area.

1. **Nothing in Agency starts `mlx_audio.server`, or the web UI behind
   it.** Agency runs `lib/cli/mlxSpeechServer.py` instead.
2. **No endpoint chooses a model.** Each process is started on one model
   directory with `--model`, and that is the only model it will ever load.
   A request names a model only so the front door can route it, and the
   door rewrites that field to the directory the process was started with,
   answering 404 for any other name. Adding an endpoint that loads a model
   named in a request would reintroduce exactly this bug.
3. **`trust_remote_code` is never passed.** In mlx-audio 0.5.4 it appears
   once, at `tts/utils.py:224`, in the `convert()` CLI helper, which
   nothing here calls. `load_model` does not take it, and both model
   classes load their tokenizer with the default, which is `False`. Do not
   call `convert()`, and do not pass the flag.
4. **Everything binds `127.0.0.1`**: the speech script, the embedding
   script and the front door.
5. **Requests carry a JSON body, never query-string parameters**, and the
   body is parsed strictly. A browser form cannot produce a body that
   `json.loads` accepts, so it cannot reach the generation path.

If a state-changing endpoint is ever needed, it has to reject cross-origin
requests server-side: check `Origin` against an allowlist, or require a
header that forces a preflight. A JSON content type alone is not enough,
because `fetch` can send `text/plain`.

The finding is against mlx-audio 0.5.4, the version this server pins, and
was not reported upstream at the time of writing. The version pin is the
thing that keeps this file's claims true: if it moves, read
`mlx_audio/server.py` and `tts/utils.py` again.

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
| `llama` | | Orpheus | one of eight named voices; `tara` by default | refused: emotion goes in the text as tags |

A Base model needs a reference recording, which this server does not take.

Each family is one row in the `FAMILIES` table in the rules module.
`check_request` reads the row, so adding a family means adding a row.

## Orpheus

Orpheus is an English model that performs emotion from tags in the text:

    agency local download orpheus-3b-mlx
    agency local serve --speech orpheus-3b-mlx

Its tags are `<laugh>`, `<chuckle>`, `<sigh>`, `<cough>`, `<sniffle>`,
`<groan>`, `<yawn>`, and `<gasp>`. It takes no `instructions`, so a request
that sends them is refused with the tag list instead. Its
`max_tokens` is 8000, about 58 seconds of speech: mlx-audio's default of
1200 cuts a sentence off after 8.7 seconds and reports nothing.

Orpheus needs two things Qwen3-TTS does not. It loads the SNAC audio
decoder from `mlx-community/snac_24khz` by repo id, and it loads its
tokenizer from the full-size `bf16` repo by repo id. Both happen through
huggingface_hub, which cannot run offline against an empty cache.

### Companions

The catalog entry lists what a model loads by name:

    companions: ["mlx:mlx-community/snac_24khz"],

`agency local download` fetches each companion after the model, into the
same layout. The field is a download hint and nothing else: `serve` never
reads it, and `agency local remove -f` leaves companions alone, because
another model may share one. The lookup happens in the script, always by
repo id.

Which entry a value names is decided by `companionsFor` in
`lib/stdlib/localModels.ts`. An alias answers for itself, even one that
shadows a catalog name, since it may point at a model with no companion.
Otherwise the curated entry answers, found by catalog name or by the repo
the value resolved to, so `mlx:mlx-community/orpheus-3b-0.1-ft-4bit` and
that URI with a pinned revision both fetch SNAC. A remote catalog can
declare `companions` too: the field survives `agency local refresh` into
the alias it writes.

A companion that sits in the models directory in Hugging Face cache layout
(`models--<org>--<repo>/snapshots/<sha>/`) is not found by that lookup. The
fallback, mlx-audio's own loader, finds it only when `HF_HOME` points at
that directory.

### The three patches

`patch_mlx_audio_for_orpheus` in `mlxSpeechServer.py` changes three things
in mlx-audio 0.5.4 before the Orpheus module is imported. They are not
reported upstream. Remove each one when a release carries the fix and the
version pin moves.

1. **`fetch_from_hub`** (`codec/models/snac/snac.py:205`) looks in
   `<models-dir>/mlx/<org>--<repo>` first, and falls back to the original,
   so a Hugging Face cache that already holds SNAC still works. When
   neither has it, the refusal names the download command.
2. **`_eos_ids`** (`lm/generate.py:99`) does `set(tokenizer.eos_token_ids)`,
   and the Orpheus tokenizer's value is a single int, which raises
   `TypeError`. The patch accepts an int.
3. **`ModelConfig.from_dict`** (`tts/models/llama/llama.py:21`) puts the
   model directory in as `tokenizer_name`, so the tokenizer comes from the
   4-bit repo's own files rather than the 6.6 GB `bf16` repo.

The order matters. Patch 3 imports the Orpheus module, and importing it
runs `SNAC.from_pretrained` at module level (`llama.py:32`), so patch 1 has
to be in place first.

Patch 3 wraps `from_dict` rather than setting `ModelConfig.tokenizer_name`,
because `base_load_model` builds the config with
`ModelConfig.from_dict(config)` (`mlx_audio/utils.py:389`), and the
dataclass default was fixed when the class was created. Setting the
attribute afterwards changes nothing.

A wrong tokenizer does not raise. It produces speech that sounds garbled,
and only listening catches it. That is why the mlx-audio version is a
refusal rather than a warning.

## speakLocal

Agency code reaches a served model through `std::speech`:

    import { speakLocal } from "std::speech"

    node main() {
      print(speakLocal("Hello there.", "qwen3-tts-mlx", "ryan", "Calm."))
    }

It returns the path of the file it wrote, and raises `std::localSpeech`
before writing anything. That effect is separate from the cloud
`std::synthesizeSpeech`, so approving one never approves the other.

`speakLocal` is its own function rather than a provider on `speak` because
the arguments do not match: a local call takes `instructions` and no
`apiKey`, its `speed` stretches finished audio rather than asking the model,
and its effect would otherwise depend on an argument, which a handler cannot
match on.

### What it shares with speak

`synthesizeToFile` in `lib/stdlib/speech.ts` owns everything both paths do
the same way: resolve and authorize the output path, refuse to overwrite an
existing file, run the work inside `meteredDispatch`, record usage, send the
statelog event, enforce guards, check the MIME type, and publish the bytes.
Each caller supplies a `produce` function, the MIME type it expects, and
optionally a `finish` function that runs after accounting. Every failure message starts
with the caller's name, so the local one reads `speakLocal failed: …`.

### Pieces

`_speakLocal` splits the text with `sentencePieces` into pieces of at most
500 characters and sends each one to the server as its own request, asking
for raw PCM. For `format: "wav"` the samples are joined under one header
written by `wavFile` (`lib/stdlib/wavFile.ts`); for `"pcm"` they are
concatenated as they came, with no header. Neither needs ffmpeg. Both
modules are copied from the Kokoro package.

The 500-character limit bounds cancellation: a cancelled call holds the
server's generation lock for one piece rather than for the whole text. It
is not about retries, which smoltalk's `mlx` speech client turns off with
`maxRetries: 0`, since the server runs one generation at a time.

All the pieces run inside one `meteredDispatch`, so a call produces one
usage record and one statelog event however many requests it makes, at zero
cost. A cancelled call throws out of `produce`, so the invocation's usage is
marked incomplete even though a local call costs nothing, as cloud `speak`
does today.

The WAV header's sample rate comes from smoltalk, which reports 24000 for
every PCM reply rather than reading what the server sent. Both served
families are 24 kHz. A model at another rate would need smoltalk to pass
the server's own rate through.

### Formats and speed

`speakLocal` writes `wav`, `mp3`, `m4a`, or `pcm`. `resolveLocalFormat` in
`speech.ts` picks one: the `format` argument, then the output file's
extension, then wav. An explicit format wins over the extension, as in the
Kokoro package, so this call writes wav bytes to `a.mp3`:

    speakLocal("Hi.", "qwen3-tts-mlx", outputFile: "a.mp3", format: "wav")

Cloud `speak` refuses the same mismatch. The check lives in
`_synthesizeSpeech`, not in `synthesizeToFile`, so that the two can differ.
The `std::localSpeech` interrupt carries the chosen `format` next to
`outputFile`, so a person approving the call sees both.

Neither served family can change its own speed, and the server refuses any
speed other than 1. So `speakLocal` always asks the server for pcm at speed 1,
and changes the speed itself. It joins the pieces into a wav, and ffmpeg's
`atempo` filter stretches it without changing the pitch. The range is 0.5 to
2, the same as Kokoro's. Near either end the voice sounds slightly processed.

ffmpeg runs for mp3, m4a, or a speed other than 1. It is not needed for wav
or pcm at speed 1. `_validateSpeakLocalArgs` checks for ffmpeg before the
interrupt, after the format and speed checks, so a bad format or speed gives
the same error with or without ffmpeg installed.

The ffmpeg run happens in `synthesizeToFile`'s `finish` step, which runs
after the usage is recorded and the guards are checked. When `produce`
fails, the call's usage is marked incomplete, because a failed request to a
paid provider may still have cost money. An ffmpeg failure has nothing to do
with cost, so it happens after that point. It still writes no file. The
statelog `timeTaken` covers the model's time only.

`lib/stdlib/ffmpeg.ts` was copied from `packages/kokoro/src/ffmpeg.ts`, with
wav and pcm output and the speed filter added. The wav output drops ffmpeg's
`LIST` chunk, so the file is the header plus the samples. The pcm output
needs `-f s16le`, because ffmpeg cannot tell raw samples from a `.pcm`
extension. Kokoro still uses its own copy. It declares `agency-lang >=0.19.3`
as a peer dependency, and moving it to the core copy means raising that.

`throwAbortReason` lives in `lib/stdlib/abortReason.ts`, so that
`ffmpeg.ts` and `speech.ts` do not import each other. `speech.ts`
re-exports it, because Kokoro imports it from
`agency-lang/stdlib-lib/speech.js`.

The tests that run the real ffmpeg are in `lib/stdlib/speech.ffmpeg.test.ts`,
apart from `speech.test.ts`, which mocks `ffmpeg.js` for the whole file. They
skip when ffmpeg is missing. The `speech-ffmpeg` job in
`.github/workflows/test.yml` installs ffmpeg and sets
`AGENCY_REQUIRE_FFMPEG=1`, which makes them fail instead of skip.

### The address and the model name

`mlxBaseUrl()` (`lib/stdlib/mlxServerModels.ts`) resolves `client.baseUrl.mlx`,
then `MLX_BASE_URL`, then `http://127.0.0.1:8080/v1`. One call feeds both the
request's `baseUrl.mlx` and the "no server" message, so `speakLocal` always
reaches the same server `agency run --local` does, and the message names the
address it actually tried:

    speakLocal failed: no MLX server answered at http://127.0.0.1:8080/v1. Start one with:
      agency local serve --speech qwen3-tts-mlx

`_resolveModel` and `_mlxServedName` turn a catalog name, an `mlx:` URI or a
repo id into the string the front door routes on, so all three spellings
reach the same process.

## Refusing instead of ignoring

A request the model cannot honour gets a 400 that names what it takes:

    "alloy" is not a voice of this model. Its voices are serena, vivian, ...

The same goes for a `speed` other than 1, which no family supports, and a
`response_format` other than `wav` or `pcm`. `speakLocal` still offers
other speeds and mp3 and m4a: it always asks the server for pcm at speed 1,
and does the rest with ffmpeg (see "Formats and speed"). A model calling the speech
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
