# Testing

Agency has a built-in test runner. See the [testing guide](../guide/testing.html) for an overview of how Agency tests work; this page focuses on the CLI.

## Running tests

```
agency test foo.test.json
agency test tests/
```

You can pass `.test.json` files or directories; directories are scanned recursively. With no arguments, the test runner uses the default test directory.

### Options

- `-p, --parallel <number>` — number of test files to run in parallel.

## Generating fixtures

```
agency test fixtures foo.agency:nodeName
```

Run a node interactively, capture its behavior, and write a `.test.json` fixture next to the source file. The target is `file.agency:nodeName`. See [the testing guide](../guide/testing.html) for the full fixture flow.

## JS integration tests

```
agency test js tests/
```

Runs JavaScript integration tests (Agency code paired with `.test.ts` files that exercise it from TypeScript).

- `-p, --parallel <number>` — number of test directories to run in parallel.

## Evals

*work in progress*

```
agency test eval foo.agency:nodeName --args args.json
```

Runs an evaluation against a node. Arguments are read from a JSON file via `--args`. To resume an interrupted eval run, pass `--results <path>` pointing at the existing results file — the runner will pick up where it left off.
