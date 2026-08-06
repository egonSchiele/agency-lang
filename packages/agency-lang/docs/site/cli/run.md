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
- `--model <name>` — the model this run's `llm()` calls use by default, written as `model` or `provider/model`. See [choosing a model](#choosing-a-model) below.

## Choosing a model

`--model` sets the model for a run without editing any files, which is handy for
comparing two models against the same program:

```bash
agency run --model claude-opus-4-8 greet.agency
agency --model claude-opus-4-8 greet.agency
```

**It only changes the default.** A model chosen in your Agency code still wins,
whether that is `setModel()` from [`std::llm`](../stdlib/llm) or a single
`llm(prompt, { model: "..." })` call. The flag is the value used when nothing
else says otherwise.

### Naming a provider

Most of the time the model name is enough — agency looks it up and knows which
provider it belongs to. When it isn't, put the provider first, separated by a
slash:

```bash
agency run --model anthropic/claude-opus-4-8 greet.agency
agency run --model openrouter/anthropic/claude-sonnet-4 greet.agency
agency run --model my-company/my-fine-tune greet.agency
```

Only the **first** slash separates the two parts. That matters for OpenRouter,
whose model names contain a slash of their own: in the second example the
provider is `openrouter` and the model is `anthropic/claude-sonnet-4`.

Any name works as a provider, not just the built-in ones, so a provider you
registered yourself with
[`providerModules`](../guide/custom-providers) works the same way.

### A bare name clears a configured provider

If your `agency.json` sets `client.defaultProvider`, a bare `--model` clears it
and lets agency work the provider out from the model name. That is what "just
give me this model" means, but it is worth knowing if you use a provider to
route requests somewhere specific:

```bash
# agency.json says defaultProvider is "litellm"

agency run --model gpt-4o-mini greet.agency          # goes straight to OpenAI
agency run --model litellm/gpt-4o-mini greet.agency  # keeps your proxy
```

Naming the provider keeps it.

### Unknown names

A bare name has to be one agency knows about, so a typo is caught before
anything runs rather than after your program has already done work:

```
$ agency run --model gpt-4o-minii greet.agency
error: option '--model <name>' argument 'gpt-4o-minii' is invalid. Unknown model "gpt-4o-minii".
  Did you mean "gpt-4o-mini"?
  For a model from another provider, write provider/model — e.g. openrouter/gpt-4o-minii.
  Run `agency models list` to see the catalog.
```

A name with a provider in front is never checked, because agency has no way to
know what models your provider offers. So if you want a model agency hasn't
heard of — a brand new release, or anything behind a provider of your own — put
the provider in front and it will be passed through untouched.

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
