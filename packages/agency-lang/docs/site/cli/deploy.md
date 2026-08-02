---
title: Deploying an agent
description: Documents the `agency deploy` command, which uploads an agent's source to a hosted statelog so it can be served over HTTP, reusing the log config for the target.
---

# Deploying an agent

`agency deploy` uploads an agent to a hosted [statelog](https://github.com/egonSchiele/statelog) so it can be served over HTTP — a hosted equivalent of `agency serve http`. Statelog compiles the source, stores it, and exposes each exported node and function at a `/serve/...` URL. Every hosted run also traces back into statelog automatically.

```
agency deploy agent.agency
```

On success it prints the agent's serve endpoints and a ready-to-run curl command for each.

## Where it deploys to

The target — statelog host, project, and API key — comes from the `log` section of your `agency.json`, the same config observability already uses:

```json
{
  "log": {
    "host": "https://statelog.example.com",
    "projectId": "my-project"
  }
}
```

The **API key is read from an environment variable**, never from `agency.json` or a flag, so it stays out of version control and process listings. By default `agency deploy` reads `STATELOG_API_KEY`:

```
export STATELOG_API_KEY=sk_...
agency deploy agent.agency
```

## Options

- `--host <url>` — statelog host, overriding `log.host`.
- `--project <slug>` — project slug, overriding `log.projectId`.
- `--api-key-env <name>` — environment variable to read the API key from (default: `STATELOG_API_KEY`).
- `--dry-run` — resolve the target and validate the agent, printing exactly what would be uploaded, without sending anything.

The global `-c, --config <path>` option selects which `agency.json` to read.

## What gets uploaded

`agency deploy` uploads the entrypoint and every local `.agency` file it imports (transitively), compiling them locally first so obvious errors surface before any upload. statelog compiles them again server-side.

**All the files must sit in one directory.** statelog stores an agent's files flat, so a local import that resolves outside the entrypoint's directory (e.g. `./sub/helper.agency` or `../helper.agency`) is refused. Local TypeScript/JavaScript interop imports are also refused — statelog only compiles `.agency` source.

## Running a deployed agent

Use the printed curl commands, or hit the endpoints directly with the same API key:

```
curl -s -X POST "https://statelog.example.com/serve/<user>/<project>/agent/node/main" \
  -H "Authorization: Bearer $STATELOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}'
```

Responses come back as `{ "success": true, "value": ... }`. Tool failures are reported in the body (`{ "success": false, "error": ... }`) with HTTP 200, so check the `success` field. If a node raises an interrupt, continue by POSTing `{ interrupts, responses }` to the agent's `/resume` endpoint.
