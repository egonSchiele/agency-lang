# Local models: one way to download, list, serve, and call any kind of model

## The problem

`agency local` began with one kind of model, a chat model on llama.cpp. It
now serves five, and the sixth is on the way:

| Kind | What it returns | Engine | Serve flag | Stdlib call |
|---|---|---|---|---|
| chat | text | llama.cpp or MLX | none | `llm()` with `--local` |
| embedding | vectors | MLX | `--embedding` | memory config |
| speech | audio | MLX (mlx-audio) | `--speech` | `speakLocal` |
| image | images | diffusers (torch) | `--image` | `generateImageLocal` |
| vision (next) | boxes, tags, captions | transformers, ONNX, or MLX | none yet | none yet |
| fine-tuning (next) | an adapter file | torch | not a server | none yet |

Each kind arrived with its own flag, its own Python modules, its own
catalog category, and its own function. The user has to know which flag a
model needs before serving it, the catalog knows it for catalog models and
refuses the wrong flag, and a model named by URI or directory has to be
guessed at from its backend. This spec is the shape all of them should
have before the sixth kind is added.

Two things are settled already and are not reopened here:

- **The front door stays.** One port, one process per model behind it, one
  Python script per engine that Agency ships. `local-images.md` and
  `local-speech.md` give the security reasons.
- **Fine-tuning is not in the core package.** A trainer pulls in the
  training half of torch, days of hyperparameter knowledge, and a dataset
  pipeline. It belongs in a workspace package, like `whisper-local` and
  `tesseract-local`, and only the *loading* of what it produces (a LoRA
  adapter, `--lora`) is core.

## What the spike found

The `image-lora` branch is a working spike. What it settled:

- **Loading an adapter is small.** An SDXL family row in the rules table,
  a `--lora name=file.safetensors` flag on `serve` that goes to the one
  `--image` process, and `lora` and `lora_scale` request fields. The
  adapter is applied only to the request that names it. A request can name
  an adapter the user loaded, never a file. About 300 lines with tests.
  The final design replaces the flag with an adapters folder (section 2)
  but keeps the request fields and the rules.
- **Training an adapter is small too, and runs offline.** A 400-line
  script trains a style adapter for NoobAI-XL from 56 drawings in 14
  minutes on an M5 Ultra, under a second a step, and the result loads
  through diffusers' own loader. The script forces Hugging Face offline
  before importing torch, so it makes no network request at all.
- **Machine captions beat hand captions, and the trigger word matters
  less than expected.** A second run on 113 drawings captioned by the
  tagger drew cleaner, more on-prompt images than the hand-captioned run.
  A third run on the same set with a nonsense trigger, `grkalg`, learned
  the line but not the monochrome: its bicycle kept its orange paint. The
  real phrase `pen and ink` starts from the base model's idea of ink and
  gets there in 1200 steps; the nonsense word would need more. The beige
  paper tint both runs show comes from the base model, not the trigger.
- **The tagging problem is solved by one more model.** The WD14 tagger
  (an ONNX file, 1.2 GB, apache-2.0) wrote booru captions for 583 drawings
  in six minutes on the CPU. Those captions are the same vocabulary the
  NoobAI prompt takes. It is a *vision* model in the sense above, and the
  first one Agency would want.
- **The catalog's license rule keeps SDXL finetunes out.** NoobAI-XL and
  Illustrious both declare their own terms, so neither can be a catalog
  entry. Users name them by `diffusers:` URI or directory, which is why the
  "what kind is this model" question below matters: nothing tells `serve`
  what such a model is.

## The design

### 1. A model has a kind, and the kind is recorded when it is downloaded

Today there are two overlapping notions. `ModelCategory` in the catalog
mixes what a model is for (`general`, `coding`, `reasoning`, `writing`,
`science`, `uncensored`) with what it returns (`embedding`, `speech`,
`image`). `ServeKind` in `localServe.ts` is the second half of that list
plus `chat`. The catalog category decides which flag a model needs, and
only for catalog models.

Split the two:

- **`kind`** is what a model takes and returns. It decides which server
  script runs it, which route serves it, and which stdlib function calls
  it. The set is closed and small: `chat`, `embedding`, `speech`, `image`,
  `vision`. A vision model is one that takes an image and returns
  structured data: boxes, tags, a caption, text. (A vision-language chat
  model that takes images and returns text is `chat`; it goes through
  `/v1/chat/completions` with image parts, as it does with hosted
  providers.)
- **`tags`** is what a model is good for: `coding`, `reasoning`,
  `uncensored`, `illustration`, `photoreal`. Free-form, for the picker and
  the list, never for routing.

The kind is written into `.agency-model.json` when a model is downloaded,
next to the backend and the file list, so every downloaded model knows its
kind whether or not the catalog knows the model. For a catalog model it is
the catalog's. For a URI or directory it is inferred from the files:

| Files | Kind |
|---|---|
| `model_index.json` naming a pipeline in the image family table | `image` |
| `config.json` whose `architectures` is a causal LM | `chat` |
| `config.json` whose `architectures` is an embedding model, or `sentence_transformers` config | `embedding` |
| a `.gguf` file | `chat` |
| `model_index.json` naming a TTS pipeline, or a `mlx-audio` config | `speech` |
| `config.json` naming a detector or tagger class in the vision family table, or an `.onnx` with `selected_tags.csv` | `vision` |

Where the files are ambiguous, `download --kind <kind>` says, and the
record keeps it. A directory that was never downloaded (a Hugging Face
cache snapshot, a folder someone copied) is inferred at serve time by the
same function.

### 2. `serve` takes models, not flags

    agency local serve qwen3.5-9b-mlx noobai-xl wd14-tagger qwen3-tts-mlx

Each model's kind picks its process. The `--embedding`, `--speech`, and
`--image` flags stay as *assertions*, not selectors: `--image x` means
"refuse to start unless x is an image model", which is what they already
do for catalog models. New users never need them. The banner groups the
served models by kind, as it does now, and the sample call under each
group is the stdlib function for that kind.

Per-model options that only one kind takes, such as `--draft` for a chat
model, attach to the model they follow:

    agency local serve qwen3.5-9b-mlx --draft qwen3.5-2b-mlx noobai-xl

This is the one syntax change with a cost: today `--draft` applies to
every chat model served. Positional attachment is how `ffmpeg` and
`docker run` handle per-target options.

LoRA adapters are not a serve option at all. They come from a folder:

    // agency.json
    { "client": { "adaptersDir": "./adapters" } }

Every `.safetensors` file in that folder is an adapter, named by its
filename without the extension, and a request asks for one by that name:

    generateImageLocal("sketch, a cat on a chair", "noobai-xl", lora: "sketch")

The server loads `./adapters/sketch.safetensors` the first time a request
names it and keeps it loaded. Dropping a new file into the folder makes it
usable with no restart, which is the train-try-adjust loop a person
training adapters is in. A request still names a file only by its stem:
the server joins the name to the folder, refuses a name with a path
separator or a `..`, refuses a symlink, and refuses anything but
`.safetensors` (a `.bin` adapter loads through pickle and runs code). The
user chooses the folder, so the user chooses the files. `serve` passes the
folder to each image process as `--adapters-dir`; the spike's `--lora
name=file` flag goes away.

### 3. `list` shows everything, grouped by kind, with a filter

    agency local list                # every model on disk, grouped by kind
    agency local list --kind image   # one kind
    agency local list --all          # the catalog too, downloaded or not

The columns are name, kind, engine, size, and whether it is downloaded.
Grouping by kind answers the question the user has when they look: "what
can I serve for images?" One flat list sorted by name does not.

The picker `serve` opens with no arguments does the same: every kind, in
groups, multi-select, rather than chat models only.

### 4. Aliases carry no kind

`agency local alias add sketch-model diffusers:Laxhar/noobai-XL-1.1` and
the `modelAliases` map in `agency.json` stay a name-to-URI map. The kind
comes from the model the alias resolves to, so an alias for an image model
serves as an image model with nothing else said. An alias should never be
able to disagree with its model about what the model is.

### 5. One route per kind, and one stdlib module per kind

The routes follow the OpenAI shape where one exists and Agency's own where
none does:

| Kind | Route |
|---|---|
| chat | `/v1/chat/completions` |
| embedding | `/v1/embeddings` |
| speech | `/v1/audio/speech` |
| image | `/v1/images/generations` |
| vision | `/v1/vision/detections`, `/v1/vision/tags`, `/v1/vision/captions` |

Vision gets three routes because the three tasks return different shapes
and a model usually does one of them. Florence-2 does all three; the
server lists which routes a loaded model answers, and the front door
returns 404 with the reason for the others, as it does for a model that is
not served.

The stdlib keeps one module per kind with the functions the kind has:
`std::image`'s `generateImageLocal`, `std::speech`'s `speakLocal`, and a
new `std::vision` with `detectObjects`, `tagImage`, and `captionImage`.
The `Local` suffix marks the functions that need `agency local serve`
and cost nothing; it stays, and the vision functions get it too. Every one
takes the model as its second argument, by catalog name, alias, URI, or
directory, and the front door's 404 tells the caller the serve command
when it is not running.

### 6. Fine-tuning is a package

`packages/lora` (name to be chosen) is an Agency package in the shape of
`whisper-local`: an `index.agency` over a TypeScript implementation that
runs a Python trainer. Its surface is small:

    import { trainLora } from "pkg::lora"

    node main() {
      const r = trainLora("./drawings", trigger: "pen and ink", base: "noobai-xl", out: "./sketch.safetensors")
    }

`trainLora` raises an effect, `lora::train`, before it starts, because it
runs for minutes, writes a file, and uses the GPU. Its data names the
image folder, the base model, and the output path. The trainer is the
spike's script, forced offline, with the caption and padding conventions
the spike settled (caption the content, not the style; pad, do not crop).
Dataset preparation, the detect-crop-tag loop over a folder of comic
pages, is Agency code in the same package's examples, built on
`std::vision`, since every step of it is a tool call with an effect the
user can approve once.

The package depends on `agency-lang` for the Python environment `agency
local serve` already checks for, and adds nothing to it. The adapter it
writes is what `--lora` loads. Nothing about training is in the core
package, and the core package's only knowledge of adapters is the loading
half.

## What changes, in order

1. `kind` in the model record and the inference table, with `download
   --kind`. `serve` reads it; the flags become assertions. Tests for the
   inference table on the real `model_index.json` and `config.json` files
   already checked into the test fixtures.
2. `list` grouped by kind with `--kind`, and the picker over every kind.
3. `ModelCategory` split into `kind` and `tags` in the catalog. The
   catalog's `image` entries stay; SDXL finetunes stay out on license.
4. Per-model options by position on `serve`. `--draft` moves from
   "every chat model" to "the chat model before it", with a note in the
   changelog.
5. `std::vision` and the vision server script, starting with the WD14
   tagger (ONNX, no torch) and Florence-2 (transformers), each a row in a
   family table like the image server's.
6. The LoRA loading half from the spike, rebased onto 1 and 4, with the
   adapters folder in place of the `--lora` flag.
7. `packages/lora`, from the spike's trainer.

Steps 1 to 4 are the DX change and can ship without 5 to 7. Step 6 is
the spike's code and is small. Steps 5 and 7 are new features with their
own specs: `2026-09-28-vision-models.md` and `2026-09-28-lora-package.md`.
ControlNet, which the posing goal needs, is `2026-09-28-controlnet.md`,
an addendum to the image server.

## Decisions

- **A vision-language chat model is `chat`.** It answers
  `/v1/chat/completions` with image parts, which `llm()` already sends.
  A model that only detects is `vision`. If a model turns out to do both,
  the record grows a `capabilities` list rather than a second kind; the
  kind stays one word because it picks the process.
- **One Python environment.** `serve` already checks only the modules the
  served kinds need, and a venv per kind would be more to explain than it
  saves.
- **Adapters come from a folder, not a serve flag.** Section 2. A request
  picks a filename from a folder the user configured; nothing is named at
  serve time and nothing needs a restart.

## The whole flow, once every spec is in

What a person does to teach a model their drawing style and hand it to an
agent, end to end. Every step is either a shell command or an Agency
program, and every step that writes a file or runs the GPU for minutes
raises an effect the person approves once.

**1. Get a base model and the vision models.**

    agency local download diffusers:Laxhar/noobai-XL-1.1
    agency local download wd14-tagger florence-2
    agency local serve noobai-xl wd14-tagger florence-2

Three models, three kinds, no flags: `download` recorded what each is.
`list` shows them grouped by kind.

**2. Turn a folder of pages into a training set.** One Agency program,
from the `lora` package's examples, over `std::vision`:

    import { detectObjects, tagImage } from "std::vision"
    import { crop } from "std::image"

    node main() {
      for (page in listFiles("./comics")) {
        for (box in detectObjects(page, ["person", "desk", "chair"], "florence-2")) {
          const out = "./dataset/${box.label}_${box.id}.png"
          crop(page, box.box, out)
          writeFile("${out}.txt", tagImage(out, "wd14-tagger").join(", "))
        }
      }
    }

Run it with `--approve std::write` and it labels a few hundred crops
unattended. Look at them, delete the bad ones.

**3. Train.**

    import { trainLora } from "pkg::lora"

    node main() {
      trainLora("./dataset", trigger: "pen and ink", base: "noobai-xl", out: "./adapters/sketch.safetensors")
    }

About fifteen minutes on an M5 Ultra for a thousand steps. The trainer
writes a before/after grid at every checkpoint so the run can be judged
while it goes, and the adapter lands in the adapters folder.

**4. Try it.** The server is still running and the folder is configured,
so the new file is usable at once:

    generateImageLocal("pen and ink, a cat on a chair", "noobai-xl", lora: "sketch")

Not right yet: fix the captions, or the trigger, or the step count, and
train again to `sketch-2.safetensors`. Compare the two by name in the same
program. Nothing restarts. Delete the losers from the folder.

**5. Pose a character.** With a ControlNet loaded the same way (its own
folder entry, `controlImage` on the request), a stick figure becomes the
pose:

    generateImageLocal("pen and ink, zxq_girl, surprised", "noobai-xl", lora: "zxq", controlImage: "./poses/jump.png")

**6. Hand it to an agent.** An agent's tool is an Agency function. One
that draws in the learned style is four lines, with the adapter name
fixed so the model cannot pick another:

    def drawSketch(subject: string): Result<LocalImage> {
      """Draw the subject as a pen-and-ink illustration in the house style."""
      return generateImageLocal("pen and ink, ${subject}", "noobai-xl", lora: "sketch")
    }

Give it to `llm()` in `tools:`, or to `agency agent` as a learned tool.
The agent now draws in that style whenever it decides an illustration is
called for. Saving the picture goes through `writeBinary`, so the person
still approves each file the agent writes, or sets a policy that approves
writes under one folder.

Two properties hold the whole way through. Nothing leaves the machine:
the models, the drawings, the adapters, and every generated image stay on
disk here, and the trainer and servers run with Hugging Face offline. And
the person chooses the files: a request names an adapter by a filename in
a folder they configured, an agent's tool fixes the adapter it uses, and
every write is an effect.
