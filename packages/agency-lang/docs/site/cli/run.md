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

Please squash merge these commits. On to mean. Do not commit. Just leave them staged so I can read the commit message.

Thanks. Now I'm seeing multiple issues with the JSON viewer. One is that the JSON shows up in a separate section. It's nice because the JSON is pretty large, but I was expecting it to be in line. It's also not immediately clear that there is a separate section to go to since the toolcall node, for example, has a circle symbol, so it's not clear that there is more content there.
Also, I noticed that once I get to that separate section, it seems impossible to get back to the main tree. If I press the left arrow, it doesn't take me back. If I press escape, it seems to take me back briefly, but then if I press another key after escape, sometimes the viewer crashes with the following error:

```
> agency-lang@0.1.3 a /Users/adityabhargava/agency-lang/packages/agency-lang
> node ./dist/scripts/agency.js logs view statelog.log

file:///Users/adityabhargava/agency-lang/packages/agency-lang/dist/lib/logsViewer/jsonView/build.js:49
        entries: Object.entries(value).map(([key, child]) => ({
                        ^

TypeError: Cannot convert undefined or null to object
    at Object.entries (<anonymous>)
    at buildJsonTree (file:///Users/adityabhargava/agency-lang/packages/agency-lang/dist/lib/logsViewer/jsonView/build.js:49:25)
    at file:///Users/adityabhargava/agency-lang/packages/agency-lang/dist/lib/logsViewer/jsonView/build.js:51:20
    at Array.map (<anonymous>)
    at buildJsonTree (file:///Users/adityabhargava/agency-lang/packages/agency-lang/dist/lib/logsViewer/jsonView/build.js:49:40)
    at file:///Users/adityabhargava/agency-lang/packages/agency-lang/dist/lib/logsViewer/jsonView/build.js:51:20
    at Array.map (<anonymous>)
    at buildJsonTree (file:///Users/adityabhargava/agency-lang/packages/agency-lang/dist/lib/logsViewer/jsonView/build.js:49:40)
    at syncJsonPane (file:///Users/adityabhargava/agency-lang/packages/agency-lang/dist/lib/logsViewer/run.js:132:18)
    at runViewer (file:///Users/adityabhargava/agency-lang/packages/agency-lang/dist/lib/logsViewer/run.js:110:21)
```

I would suggest just displaying the JSON inline, maybe with a slightly different color background or something to separate it visually from the rest of the tree.
Alternatively, maybe we could display it in a second column on the right-hand side instead, but it seems like displaying it separately is causing a lot of bugs, so maybe in line would be best.

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