# Formatting Agency code

Agency ships with a formatter that you can run on a single file, a list of files, or whole directories. You can use `format` or its alias `fmt`:

```
agency format foo.agency
agency fmt src/
```

By default, the formatted output is printed to stdout. If no input is given, the formatter reads from stdin, which makes it easy to wire up to an editor or a pipeline:

```
cat foo.agency | agency fmt
```

## Options

- `-i, --in-place` — overwrite the input file(s) with the formatted output instead of printing to stdout.
