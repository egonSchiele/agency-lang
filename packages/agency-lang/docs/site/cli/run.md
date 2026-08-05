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

The shorthand takes the same options and splits its command line the same way,
so `agency greet.agency --name alice` works exactly like the `run` form below.

Note: This compiles the file to JavaScript and immediately executes it under the same Node binary that's running the CLI. You can also pass `--resume <statefile>` to resume a previously saved execution, or `--trace` to write an execution trace.

## Options

- `--resume <statefile>` — resume execution from a saved state file. This is what you'd use to continue a run that paused at an interrupt, after writing the user's responses into the state file. *work in progress*
- `--trace` — write an execution trace as the program runs, to `<input>.trace`. See [traces and bundles](./trace-and-bundle.html) for what you can do with a trace file.
- `--trace-file <path>` — write the execution trace to this path instead.
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

## Passing arguments to your program

Arguments after the file are passed through to your program, and you read them
with [`std::args`](../stdlib/args):

```bash
agency run greet.agency --name alice
```

**Position decides who a flag belongs to.** Agency's own flags go before the
filename; everything after it is your program's:

```bash
agency run --policy strict greet.agency --name alice
#            agency's                     your program's
```

This is the rule `node` uses, in `node --inspect script.js --verbose`.

The entry node's parameters are **not** filled from the command line. A
parameter you do not supply another way is `undefined`, and its default applies
if it has one.

Position always decides, even when the flag is one agency also defines. Writing
`agency run greet.agency --max-cost 5` sends `--max-cost 5` to your program and
does **not** cap the run's spend. Since that is easy to do by accident, agency
says so:

```
$ agency run greet.agency --max-cost 5
Warning: --max-cost went to your program, not to agency.
  Agency flags go before the filename: agency run --max-cost ... greet.agency
  Write -- before it to silence this:  agency run greet.agency -- --max-cost ...
```

If your program really does own a flag by that name, the second line silences
the warning. Nothing else needs `--`.

A compiled or packed program works the same way, since there is no agency
command line to separate from:

```bash
agency compile greet.agency
node greet.js --name alice
```

Do not carry a `--` over to that form. `std::args` reads `--` as "stop reading
flags", so `node greet.js -- --name alice` leaves `name` at its default and puts
`--name` and `alice` in `positionals`.

Note when invoking through another tool: `npx agency run file.agency -- x`
loses the `--` to npx. It works when invoking the `agency` binary directly.

This applies to `agency eval run --agent-cmd` too. A command like
`agency run writer.agency {task}` delivers the task through the program's
argv, so the agent reads it with `args()` from `std::system` rather than
declaring a parameter on `main`.
