# Running Agency code

To compile and run an Agency file in one step:

```
agency run foo.agency
```

This compiles the file and then executes its `main` node.

This is also the default if no command is specified:

```
agency foo.agency
```

## Options

- `--resume <statefile>` — resume execution from a saved state file. This is what you'd use to continue a run that paused at an interrupt, after writing the user's responses into the state file. *work in progress*
- `--trace [file]` — write an execution trace as the program runs. If you don't pass a filename, the trace is written to `<input>.trace`. See [traces and bundles](./trace-and-bundle.html) for what you can do with a trace file.
