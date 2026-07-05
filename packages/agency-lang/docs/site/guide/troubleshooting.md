---
name: Troubleshooting
description: Solutions to common issues when using Agency, such as module-not-found errors from global installs and other gotchas.
---

# Troubleshooting

Here are some common issues you might run into when using agency, and how to solve them.

## Global install issue

If you get an error that looks like this:

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

You may have installed agency globally and tried to run an agent.

Two options:

Option 1: If you compiled and ran in separate steps like this:

```
agency compile foo.agency
node foo.js
```

Use the `run` command instead:

```
agency run foo.agency
```

Option 2: use `pack` to produce a standalone script:

```
agency pack foo.agency -o foo.mjs
./foo.mjs
```

- [More info on this issue here](/cli/run).
- [More info on pack here](/cli/pack).

## Debugging your agent

Turn on logging. Create an `agency.json` with this content:

```json
{
  "observability": true,
  "log": {
    "logFile": "logs.jsonl"
  }
}
```

Run your agent

```
agency run <filename>
```

Then view the logs

```
agency logs view logs.jsonl
```

## `agency doctor`

When in doubt, run `agency doctor <file>` and the Agency agent will try to figure out the issue.