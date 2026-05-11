# Traces and bundles

Just like you can step through a program in the agency debugger and time travel back and forth, exploring different parts of the state, you can do the same with every run of the program. This makes it easy to debug user issues. For example, if a user reports strange behavior from the agent, you don't need to rely on logs to piece together what happened. You can step through every single step of the program execution, see what the state looked like at the time, and what happened next. This feature is called traces.

You can generate traces in a couple of ways:

1. Run the program with the trace command

```
agency trace foo.agency
```

2. pass in `--trace` to the run command

```
agency run foo.agency --trace
```

3. Set the `trace` and `traceFile` options in the [config file](./agency-config-file.html).

4. Set the `traceDir` option in the config file. This will automatically generate a trace for every run and output it to the specified directory with a timestamped filename.

## Inspecting traces

You can inspect a trace file using the debugger, like so:

```
agency debugger foo.agency --trace foo.trace
```

Note that you have to additionally give the source file. The trace simply stores the execution context on each step. It does not store the source, which means you have to pass that separately. This makes the trace file smaller, but also means that if the source changes, you won't be able to examine the trace. If you would like to bundle the source file with the trace, you can use the bundle command.

## Bundles

```
agency bundle source.agency source.trace
```

This creates a single .bundle file that you can then pass into the debugger and the bundle file contains both the source and the trace data.

```
agency debugger foo.bundle
```