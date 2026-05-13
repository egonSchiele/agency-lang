# Traces and bundles

Just like you can step through a program in the agency debugger and time travel back and forth, exploring different parts of the state, you can do the same with every run of the program. This makes it easy to debug user issues. For example, if a user reports strange behavior from the agent, you don't need to rely on logs to piece together what happened. You can step through every single step of the program execution, see what the state looked like at the time, and what happened next. This feature is called traces.

You can generate traces in a couple of ways:

1. Run the program with the trace command

```
agency trace run foo.agency
```

2. pass in `--trace` to the run command

```
agency run foo.agency --trace
```

3. Set the `trace` and `traceFile` options in the [config file](../guide/agency-config-file.html).

4. Set the `traceDir` option in the config file. This will automatically generate a trace for every run and output it to the specified directory with a timestamped filename.

### Options for `agency trace run`

- `-o, --output <file>` — output trace file path. Defaults to `<input>.trace`.
- `--resume <statefile>` — resume execution from a saved state file (e.g. one produced when an agent paused at an interrupt).

## Inspecting traces

You can inspect a trace file using the debugger, like so:

```
agency debug foo.agency --trace foo.trace
```

Note that you have to additionally give the source file. The trace simply stores the execution context on each step. It does not store the source, which means you have to pass that separately. This makes the trace file smaller, but also means that if the source changes, you won't be able to examine the trace. If you would like to bundle the source file with the trace, you can use the bundle command.

## Dumping a trace to JSON

If you'd like to read or process a trace programmatically, you can dump it to a JSON event log:

```
agency trace log foo.trace
```

By default this writes to stdout. Pass `-o <file>` to write to a file instead. The input can be a `.trace`, `.agencytrace`, or `.agencybundle` file.

## Bundles

```
agency bundle source.agency source.trace
```

This creates a single .bundle file that you can then pass into the debugger and the bundle file contains both the source and the trace data.

```
agency debug foo.bundle
```

Pass `-o <file>` to control the output bundle path.

## Unbundling

If you have a bundle and want to get the source files and trace back out, use `unbundle`:

```
agency unbundle foo.bundle -o out/
```

The `-o` flag is optional — without it, the bundle is extracted into the current directory.
