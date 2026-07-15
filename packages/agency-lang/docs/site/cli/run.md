---
title: Running Agency code
description: Documents the `agency run` command for compiling and executing an Agency file in one step, including the `--resume` and `--trace` options.
---

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

Note: This compiles the file to JavaScript and immediately executes it under the same Node binary that's running the CLI. You can also pass `--resume <statefile>` to resume a previously saved execution, or `--trace [file]` to write an execution trace.

## Options

- `--resume <statefile>` — resume execution from a saved state file. This is what you'd use to continue a run that paused at an interrupt, after writing the user's responses into the state file. *work in progress*
- `--trace [file]` — write an execution trace as the program runs. If you don't pass a filename, the trace is written to `<input>.trace`. See [traces and bundles](./trace-and-bundle.html) for what you can do with a trace file.
- `--max-cost <dollars>` — abort the run if its LLM spend exceeds this many dollars, e.g. `--max-cost 0.50`. `0` means no paid spend at all (local models only). A negative value means no limit. A tripped budget exits with code 3 and prints the overrun.
- `--max-time <duration>` — abort the run if its working time exceeds this duration, e.g. `--max-time 5m`. The value needs a unit: `500ms`, `30s`, `5m`, `1h`, `2d`, `1w`. Time spent waiting on a human does not count. Zero or negative means no limit. A tripped budget exits with code 3.

## A note on global installs
If you have installed agency globally, you should be aware of a classic node gotcha. A global install means that the agency CLI will be available everywhere. However, the agency-lang package can't be imported everywhere. This matters because when you compile your agency code into js, the js code imports the `agency-lang` package.

This means you may run into some very annoying behavior, where compiling the code is just fine

```
agency compile foo.agency
```

But when you try to run it

```
node foo.js
```

you get an error that looks something like this:

```
node:internal/modules/package_json_reader:316
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'agency-lang' imported from /Users/foo/hello.js
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:316:9)
    at packageResolve (node:internal/modules/esm/resolve:768:81)
    at moduleResolve (node:internal/modules/esm/resolve:858:18)
    at defaultResolve (node:internal/modules/esm/resolve:990:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:737:20)
    at ModuleLoader.resolve (node:internal/modules/esm/loader:714:38)
    at ModuleLoader.getModuleJobForImport (node:internal/modules/esm/loader:293:38)
    at #link (node:internal/modules/esm/module_job:208:49) {
  code: 'ERR_MODULE_NOT_FOUND'
}
```

If you're in an NPM project, simply install the agency-lang package locally, and this problem will go away, but if you are trying to run an agency agent as a script, just use the `run` command. The `run` command will tell node how to find the globally installed agency-lang package.

tl;dr if compile-then-run doesn't work:

```
agency compile foo.agency
node foo.js
```

Use the `run` command instead:

```
agency run foo.agency
```

You can also use [pack](./pack) to produce a standalone script that has no dependencies at all. It inlines the agency package instead of importing it, so it will run anywhere with just Node installed.