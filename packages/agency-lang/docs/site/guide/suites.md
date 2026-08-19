# Suites

We had covered suites in the [eval basics](/guide/eval-basics) section. As a reminder, here is how you would write a simple suite:

```json
{
  "inputs": [
    {
      "id": "einstein",
      "input": {},
      "goal": "returns Einstein's birthday",
      "expected": "March 14, 1879"
    }
  ]
}
```

Now we can run and grade it:

```bash
agency eval run test.agency --suite inputs.json --out runs/einstein
agency eval grade runs/einstein
```

Note that you don't need both "goal" and "expected", you only need one. By default, the grader is going to use LLM as a judge, and it will use both if both are provided.

## Other ways to write a suite

A single JSON file with an `inputs` array is the quickest way to meet and greet a suite. Here are some other ways to do it.

### A directory of test files

Instead of one file holding every test, you can give each test its own `.json` file and folder. Then point `--suite` at parent folder:

```
einstein-suite/
  birthday.json
  birthplace.json
```

```json
// einstein-suite/birthday.json
{
  "id": "birthday",
  "input": {},
  "goal": "returns Einstein's birthday",
  "expected": "March 14, 1879"
}
```

```bash
agency eval run test.agency --suite einstein-suite --out runs/einstein
```

This is nicer once a suite has more than a handful of tests.

### Add files to your test

Some agents work on files, like "summarize report.txt". You can include files as part of your test. You will need to give each test its own directory as shown above, with a `test.json` file, and a `files/` folder:

```
summarize-suite/
  quarterly-report/
    test.json
    files/
      report.txt
```

```json
// summarize-suite/quarterly-report/test.json
{
  "input": "Summarize report.txt into summary.md",
  "goal": "summary.md captures the report's main findings"
}
```

```bash
agency eval run summarizer.agency --suite summarize-suite --out runs/summaries
```

Two things happen automatically in this form:
- The test's `id` defaults to the directory name (`quarterly-report`), so you can leave it out
- The contents of `files/` are copied into the working directory the agent runs in, so the agent sees `report.txt` in its current directory, and any files it writes (like `summary.md`) get written to the run directory's `workdir/` for the graders to check.

You can also specify custom graders for the test pretty easily: just add a `graders.ts` in the test dir next to `test.json`, and it will be used for grading. Nothing else needed.

#### Other ways to add files

You don't have to use the directory form to attach files. Just name a folder with `"files": "./fixtures/quarterly"` in your JSON. The dir path will be resolved relative to the JSON file it appears in.

### A suite from git

Anywhere a suite directory is accepted, a git URL works too. This is how a team shares one set of tests across repositories, or how you pin an eval to a known version:

```bash
agency eval run test.agency --suite 'github.com/you/evals//einstein-suite?ref=v1.2'
```

The address has three parts: the repository (`github.com/you/evals`; a full `https://` URL or a local repo path work too), an optional `//subdir` naming a folder inside it, and an optional `?ref=` naming a branch, tag, or commit. The clone is cached under `~/.agency/cache/git/`. Whatever ref you gave, the run records the exact commit it resolved to, so you can reproduce any past run later by copying that commit into `?ref=`.