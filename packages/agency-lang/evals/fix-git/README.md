# fix-git eval

A re-implementation of the terminal-bench `fix-git` task so it can run against
the agency agent locally, without Docker or Daytona. It is the first experiment
in checking that the eval framework works end to end.

## The task

The agent is told:

> I just made some changes to my personal site and checked out master, but now I
> can't find those changes. Please help me find them and merge them into master.

The fixture is a clone of `TheMikeMerrill/personal-site` whose recent work was
committed onto a detached HEAD and then abandoned by a `git checkout master`. The
two changed files, `_includes/about.md` and `_layouts/default.html`, survive only
as a dangling commit. The agent has to recover it with `git reflog` or
`git fsck` and restore both files on master.

This is the always-pass smoke test in the benchmark, so a correct harness should
score a pass against a capable model.

## How it maps to terminal-bench

| terminal-bench piece | here |
|---|---|
| `setup.sh` builds the broken repo | `build-fixture.sh` reproduces the same dance offline |
| `instruction.md` | the prompt string in `run.sh` |
| `test_outputs.py` md5 checks | `grade.mjs`, same whitespace-stripped md5 compare |
| the container `WORKDIR` | a fresh copy of the fixture, one per run |

## Files

- `build-fixture.sh` — regenerates `fixture/personal-site`. First run clones the
  base history from GitHub and caches it as `personal-site.bundle`; later runs are
  offline. Both the fixture and the bundle are gitignored.
- `gold/about.md`, `gold/default.html` — the answer key. These are also the exact
  contents of the lost commit, so the grader compares the agent's result against
  the change it was supposed to recover.
- `grade.mjs` — deterministic grader. Prints a per-file result and `reward: 1|0`.
- `run.sh` — one run: copy fixture, run the agent, grade, summarize the statelog.
- `summarize-record.mjs` — prints a few facts from the extracted eval-record, to
  show statelog-based assertions in place of reading the transcript.

## Running

```bash
./build-fixture.sh                 # once; regenerates the fixture
./run.sh anthropic claude-opus-4-8 # provider and model are optional
```

`run.sh` invokes the agent exactly as the terminal-bench adapter does:

```bash
agency agent --agent code --policy approve-all -p \
  --provider <p> --model <m> --max-tool-call-rounds 100 \
  --log <statelog> -- "<instruction>"
```

The agent is run through its real CLI, unchanged, so the experiment measures the
shipped agent. `--log` writes the statelog that `agency eval extract` reads.

## Why the CLI and not `agency eval run`

`agency eval run` invokes an agency node with arguments. The agency agent's entry
node is a full CLI: it parses argv, reads stdin, and installs the policy handler.
Driving it from an eval-run wrapper would mean exporting internal functions from
the shipped agent, which risks measuring a modified agent. Running the real CLI
and extracting its statelog keeps the agent untouched while still exercising the
statelog and eval-record parts of the framework. A wrapper-node path can be added
later if we want the `runs/` layout that `eval run` produces.
