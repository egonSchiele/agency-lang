# External files and portable revisions for combined graders

Date: 2026-08-21. Status: designed for a follow-up change.

## Background

An eval test can contain both Agency test harnesses and a custom
`graders.ts`. The eval framework combines them into one generated grading
module. The run directory stores that module and assigns it a revision.

Custom graders can also declare files through `externalFiles()`. For example,
an LLM judge can keep its prompt in `judge-prompt.agency` beside
`graders.ts`:

```text
my-test/
├── graders.ts
├── judge-prompt.agency
└── files/
    ├── behavior-tests.agency
    └── behavior-tests.test.json
```

The original implementation has two related problems:

1. It resolves `judge-prompt.agency` relative to the generated module's
   temporary directory instead of the directory containing `graders.ts`.
2. Its revision covers the custom grader bundle but not the prompt contents.
   The bundle hash can also change when an unchanged test suite moves to a
   different checkout directory.

PR #876 therefore rejects `externalFiles()` when a custom grader is combined
with Agency test graders. It also documents that combined revisions are
checkout-specific. This follow-up removes both limitations together.

## Goals

- Allow custom graders combined with Agency test graders to use
  `externalFiles()`.
- Resolve relative external paths beside the original `graders.ts`.
- Store external files in the run directory and rebind them during later
  grading, as ordinary grading modules already do.
- Change the combined revision when grader code, imported helpers, harnesses,
  or external-file contents change.
- Keep the combined revision unchanged when an identical suite moves to a
  different checkout directory.
- Keep old run directories readable.

## Non-goals

- Change the `BaseGrader.externalFiles()` or `rebindExternalFile()` public
  APIs.
- Make generic grader annotator IDs path-independent. Generic IDs continue to
  include their recorded source path. This change makes the explicit logical
  revision used by combined Agency test graders portable.
- Change which TypeScript imports a grading module may use.
- Rewrite old annotations or stored grading bundles.

## Design

### Give bundling a stable working directory

`bundleGradingModule(filePath)` currently gives esbuild an absolute entry
path. Esbuild includes input paths in comments in the generated JavaScript.
Those comments change when the checkout moves, which changes the bundle hash.

The bundler will instead use the grading module's directory as esbuild's
`absWorkingDir` and pass the entry filename relative to that directory:

```ts
build({
  absWorkingDir: path.dirname(absolute),
  entryPoints: [path.basename(absolute)],
  // existing options remain unchanged
})
```

Esbuild then emits stable source labels such as `// graders.ts` and
`// helpers/check.ts`. Moving an unchanged source tree changes neither the
bundle bytes nor its hash. Renaming, adding, removing, or editing an imported
file still changes the output and the hash.

This changes newly created bundle hashes once. Existing run directories keep
their recorded bundle filename and contents, so they remain readable and
continue to use their recorded revision.

### Resolve external files from the original module

`snapshotGradingModule` will accept an optional external-file base directory:

```ts
type SnapshotGradingModuleOptions = {
  externalFilesBaseDir?: string;
};
```

The default remains the directory containing the module being snapshotted.
Ordinary callers therefore keep their current behavior.

The combined-grader path generates its module in a temporary directory, but
it will pass the directory containing the original `graders.ts` as
`externalFilesBaseDir`. Absolute paths remain absolute. Relative paths resolve
against that supplied directory. Agency test graders already declare their
harness paths as absolute paths, so changing the relative base does not affect
them.

Once this works, the generated module will no longer reject sibling graders
that declare external files.

### Retain the inputs used to calculate a revision

The snapshot code already loads every grader and reads every declared external
file. While doing that, it will also build an internal list of revision inputs:

```ts
type ExternalRevisionInput = {
  graderName: string;
  declarationIndex: number;
  sha256: string;
};
```

The list binds each file's contents to the grader and to its position in that
grader's `externalFiles()` result. Paths are deliberately absent. A path tells
the framework where to read a file, but the file contents determine grading
behavior. This representation has the required properties:

- Editing a prompt changes its hash.
- Swapping two prompts changes which hash occupies each declaration index.
- Two graders that use files with the same basename do not collide because
  the grader name and declaration index distinguish them.
- Moving the unchanged files does not change the revision.

`snapshotGradingModule` will return these inputs on `GradersSnapshot` for
in-process revision calculation. They do not need to be added to the run-row
wire format. The existing `judgeFiles` mapping and content-addressed files
remain the persisted representation used for later grading.

Grader names are already required to be distinct within a module. The
snapshot code will collect revision inputs only after that existing check has
passed.

### Calculate the combined logical revision

The combined revision will hash one canonical JSON object containing:

1. Each Agency harness name bound to the hashes of its `.agency` and
   `.test.json` files.
2. The stable bundle hash of the custom `graders.ts`, or `null` when no custom
   grader exists.
3. The external revision inputs, sorted by grader name and declaration index.

The generated combined module's bundle remains excluded. It contains the
generated module's temporary path and is an output of the inputs listed above,
not a new logical input.

The existing `sourceIdentity` remains
`agency-tests:<suite digest>/<test id>`. Old snapshots without an explicit
revision continue to use the existing legacy fallback.

## Data flow

```diagram
original graders.ts ──bundle with stable working directory──▶ stable bundle hash
       │
       └──externalFiles(), resolved beside graders.ts────────▶ stored file contents
                                                                    │
Agency harness pairs ───────────────────────────────────────────────┤
                                                                    ▼
                                                        combined logical revision
```

The generated module still contains both the custom graders and the Agency
test graders. The change affects only how preflight finds their files and how
it describes their revision.

## Errors

- A missing external file continues to fail during preflight before any agent
  runs. The error should name both the declared path and the base directory
  used to resolve it.
- Duplicate grader names continue to use the existing error.
- An external file that cannot be read continues to fail rather than being
  omitted from the snapshot or revision.

## Testing

Add focused tests for these contracts:

1. A custom grader combined with an Agency harness can read a relative
   external file beside `graders.ts`.
2. The run snapshot stores that file and a copied run directory rebinds the
   grader to the stored copy.
3. Editing only the external file changes the combined revision.
4. Swapping two external files between declaration positions changes the
   revision.
5. Copying an identical `graders.ts` and imported helper tree to another
   directory produces the same bundle hash.
6. Copying the complete unchanged test directory produces the same combined
   revision.
7. Editing an imported helper still changes the revision.
8. Existing snapshots without explicit revision metadata still load.
9. A missing relative external file fails during preflight with the declared
   path and original grader directory in the message.

Run the grading-module and synthesized-grader unit tests together. Also run
the eval grading integration tests because they verify that a stored snapshot
can grade after the original files are gone.

## Documentation changes

When implementation lands:

- Remove the temporary limitation from `docs/dev/std-agency-test.md`.
- Explain that the combined revision covers external file contents and is
  independent of the checkout directory.
- Update `docs/dev/eval-grading.md` if the new external revision inputs change
  the description of snapshot contents.
