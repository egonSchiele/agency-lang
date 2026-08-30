# How an Agency program is served through statelog

This is a plain walkthrough of what happens between typing
`agency remote deploy` and getting a JSON answer from a URL. It is the
readable companion to `hosted-agent-execution.md`, which has the
file-by-file detail. Read this one first.

Two programs are involved:

- **agency-lang** is the language. It includes the `agency` command line and
  a small library, `agency-lang/serve`, that turns a compiled program into
  something a web server can call.
- **statelog** is a web app. It stores your uploaded program, runs it when a
  request comes in, and records what happened.

## Step 1: you write a program

Nothing special is needed. Any node or function you `export` becomes
callable over the web.

```
// greeter.agency
export def greet(name: string): string {
  return "Hello, " + name
}

export node summarize(text: string) {
  const summary = llm("Summarize in one sentence: " + text)
  return summary
}
```

## Step 2: you deploy it

```
agency remote deploy greeter.agency
```

The command reads two settings from your `agency.json`: `log.host` (which
statelog server) and `log.projectId` (which project on it). It reads your
API key from the `STATELOG_API_KEY` environment variable. Then it sends the
**source text** of `greeter.agency`, plus any `.agency` files it imports, to
statelog's upload endpoint. It sends source, never compiled output.

Statelog writes each file to disk under a folder for your user and project,
compiles it once to check that it compiles, and records the file in its
database. Then it prints the URLs you can call, with a ready-made `curl`
for each:

```
curl -s -H "Authorization: Bearer $KEY" \
  "https://statelog.example.com/serve/u_123/my-project/greeter.agency/list"

curl -s -X POST "https://statelog.example.com/serve/u_123/my-project/greeter.agency/function/greet" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"…"}'
```

Every URL has the same shape:

```
/serve/<user id>/<project>/<file name>/<what to do>
```

and "what to do" is one of four things, described in step 4.

## Step 3: statelog gets the program ready to run

The first time a request arrives for a file (and again whenever the file
changes), statelog does three things:

1. **Compiles the source again.** Each compile stamps a fresh random id
   into the output, and the serve library uses that id to find the
   program's functions. So statelog cannot reuse the file it compiled at
   upload time; it compiles now and keeps the id.
2. **Writes the compiled JavaScript** next to the source, named after a
   hash of its contents (`greeter.<hash>.js`). Two requests compiling the
   same source produce the same file, so they cannot trip over each other.
3. **Loads that JavaScript into the web server** with `import(...)` and asks
   agency-lang for a *handler*.

### Where the handler comes from

agency-lang ships a small module for hosts, imported as `agency-lang/serve`
(`lib/serve/public.ts`). Its main export is `createServeHandler`. Statelog
calls it like this:

```ts
import { createServeHandler } from "agency-lang/serve";

const handler = await createServeHandler("/uploads/u_123/my-project/greeter.<hash>.js", {
  moduleId,            // the id stamped into the code by the compile in step 1
  exportedNodeNames,   // ["summarize"]
  version,             // the hash, so a changed file loads as new code
});
```

Inside, `createServeHandler` (`lib/serve/createServeHandler.ts`):

1. Imports the compiled file with `import("file:///...greeter.<hash>.js?v=<hash>")`.
   The `?v=` part stops Node from handing back a stale cached module.
2. Checks the file is really a compiled Agency program: it must export
   `hasInterrupts` and `__respondToInterruptsForServe`, which the code
   generator adds to every program. Anything else fails with a clear error.
3. Collects what can be called: every `def` from the module's
   `__toolRegistry` whose stamped id matches `moduleId`, plus the exported
   nodes by name.
4. Wraps those in a dispatcher (`lib/serve/http/adapter.ts`) and returns it.

The dispatcher is the handler. It is a function with this shape:

```ts
(method, path, body, options) => Promise<{ status, body }>
```

You give it an HTTP method, a path like `/function/greet`, the request
body, and some per-request options. It matches the path against the four
routes in step 4, turns the body into named arguments, calls the matching
compiled function or node, and turns the result into a status code and a
JSON body. Statelog keeps one handler per file in memory and reuses it for
every request. The handler holds no per-project settings; those arrive in
`options` on each call.

## Step 4: a request comes in

Say a client calls:

```
POST /serve/u_123/my-project/greeter.agency/function/greet
Authorization: Bearer sl_abc...
Content-Type: application/json

{"name": "Ada"}
```

Statelog, in order:

1. **Checks the API key** and that it belongs to the project in the URL.
2. **Loads the project's spending limit** (a maximum cost in dollars and a
   maximum wall-clock time). If this cannot be loaded the request fails;
   statelog never runs a program without knowing its limit.
3. **Finds or builds the handler** for `greeter.agency` (step 3).
4. **Puts the project's secrets into the environment.** Secrets you saved
   with `agency remote secrets` are decrypted and set as environment
   variables for the duration of this request, so the program's `env()`
   calls can see them.
5. **Calls the handler**, passing the per-request options: the spending
   limit, and where to send the run's trace (this project's own page in
   statelog, with this API key).
6. **Records the cost** of the run against the project.
7. **Sends the handler's answer back** as the HTTP response.

The answer for a function is simple:

```json
{ "success": true, "value": "Hello, Ada" }
```

If the function returned a failure, you still get HTTP 200, with:

```json
{ "success": false, "error": "…a short message…" }
```

The full error is written to statelog's log; the client sees only a
sanitized version.

## The four things you can ask for

| Path | Method | What it does |
|---|---|---|
| `/list` | GET | Describes the program: every exported function and node, its parameters, and which interrupt effects it can raise. |
| `/function/<name>` | POST | Runs one function with the body as its named arguments. |
| `/node/<name>` | POST | Runs one node the same way. Nodes can pause on an interrupt (next section). |
| `/resume` | POST | Continues a node that paused. |

## When the program asks a question: interrupts over HTTP

Interrupts are how Agency code pauses to ask for permission or input
(`docs/site/guide/interrupts.md`). On the command line, the pause shows up
as a prompt in your terminal. Over the web there is no terminal, so the
pause becomes a response.

Suppose the node writes a file, which raises `std::write`:

```
export node saveNote(text: string) {
  write("note.txt", text)
  return "saved"
}
```

Calling `/node/saveNote` does not return `"saved"`. It returns the question:

```json
{
  "success": true,
  "value": {
    "interrupts": [
      {
        "effect": "std::write",
        "message": "Are you sure you want to write this file?",
        "data": { "dir": ".", "filename": "note.txt" },
        "interruptId": "…",
        "checkpoint": { "…a snapshot of the paused program…" }
      }
    ],
    "state": "…the same array, as a JSON string…"
  }
}
```

Each interrupt object carries a **checkpoint**: a snapshot of the paused
program, taken at the moment it asked. Statelog keeps nothing about this
run in memory. Everything needed to continue travels in that object, which
is why the same statelog server can answer the next request from any
machine, any time later.

The client answers by sending the interrupt objects back, unchanged, with
one decision per interrupt. (Nothing verifies the echo — see "What a
checkpoint contains, and who can change it" below for what that means.)

```
POST /serve/u_123/my-project/greeter.agency/resume

{
  "interrupts": [ …the array from the last response, unchanged… ],
  "responses": [ { "type": "approve" } ]
}
```

(`state` is a convenience copy for clients that want to store the pause as
one string; `/resume` reads `interrupts` and `responses` and ignores it.)

The program picks up where it stopped, the file is written, and the
response is now `{ "success": true, "value": "saved" }`. If the program
pauses again, you get another `interrupts` response, so a client loops:
call, answer, call, answer, until there is a final value. To refuse, send
`{ "type": "reject" }` instead; the node stops with an "interrupt rejected"
failure. To answer an interrupt that asked for a value (`const name = raise
interrupt("Which file?")`), send `{ "type": "approve", "value": "note.txt" }`.

### What a checkpoint contains, and who can change it

A checkpoint is data only (`lib/runtime/state/checkpointStore.ts`): each
frame's arguments and local variables, the module's globals, the LLM
conversation so far, the name of the node to restart, and a step path
saying where in that node to continue. There is no code in it. On resume
the node name is looked up in the same compiled module the request is for,
and everything that then runs is that module's own code.

So the developer who deployed the program gains nothing by editing a
checkpoint. Anything they could make it do, their program could already do,
and the resume URL is tied to their project and file by the API key check.

The picture is different for an **end user** who receives interrupts from
the developer's program:

- The checkpoint carries values out. A secret the program read into a
  variable before pausing, or anything the LLM was told, is in the response.
- The checkpoint is not signed. The values are checked for shape
  (`lib/runtime/state/schemas.ts`), not for authenticity, so a caller can
  change `{ amount: 5 }` to `{ amount: 5000 }` before approving.

Until checkpoints are signed with a server key (or stored server-side and
referred to by id), the interrupt loop should stay between statelog and a
client the developer trusts.

## Root interrupt policy

A host can attach a policy to any invocation — the same JSON rule format
`agency run --policy` takes (`lib/runtime/policy.ts`) — as a fourth argument
to the serve handler:

```ts
handler("POST", "/node/main", body, {
  policy: { "std::env": [{ match: { name: "MY_SECRET" }, action: "approve" }, { action: "reject" }] },
});
```

The runtime installs it as the **outermost handler** for that invocation, in
the same bootstrap that serves nodes and functions (`initFreshExecCtx`,
`lib/runtime/node.ts`), and installs it again on every `/resume`
(`respondToInterruptsCore`, `lib/runtime/interrupts.ts`), because handlers
are never part of a checkpoint. Per invocation on purpose: a host like
statelog serves many projects through one handler, and the rule for
"which env reads are fine" differs per project.

What that buys, in chain terms (`docs/dev/runtime/interrupts.md`, "Handler
verdicts"):

- A policy `reject` settles the interrupt **at the raise**, before it ever
  becomes an HTTP response — and it wins over the program's own
  `handle { … } with approve`, because a reject beats any approve in the
  chain merge. The program sees an ordinary denial: `env()` reads the
  variable as unset, a `read()` gets a failure.
- A policy `approve` settles the raise silently; the caller never sees it.
- A policy `propagate` forces the interrupt out to the caller even when the
  program would have approved it itself — "always ask", per effect.
- Effects the policy does not mention behave exactly as with no policy.
- An interrupt raised **during** a resume leg goes through the re-installed
  policy the same way. The caller's answers to already-surfaced interrupts
  are not policy-checked: they resolve by interrupt id, the decision for
  them was made at their raise, and the echoed interrupt data is display
  information the resumed program never reads.

An invalid policy shape throws before any execution context exists; the
adapter logs the message and returns its generic error, so a host bug is
loud in the host's log and opaque to the caller. An explicit policy replaces
the `AGENCY_RUN_POLICY` environment policy for that run; it does not merge
with it, and an empty `{}` is a no-op that still disables the environment
policy. End-to-end behaviour is pinned by `tests/agency-js/serve-policy`.

One known gap: the module's top-level initialization code runs before the
handler is installed, so a raise inside a top-level initializer is not yet
governed by the policy. That ordering problem predates this feature (it
applies to `agency run --policy` too) and is tracked as B1 on
`docs/dev/security/roadmap.md` (#966).

## Where the trace goes

Every hosted run records a trace, the same kind `agency run --trace`
produces, into statelog under the project the program belongs to. This is
set per request (step 4, item 5), not baked into the compiled file, so one
statelog server can host programs from many projects and keep their traces
apart, and no API key ever sits inside a compiled `.js` file on disk.

## What is not there yet

The program runs **inside the statelog web server process**, compiled with
no restrictions on what it may import. That is fine while everyone who can
deploy is trusted by the server's owner, and today that is the rule. The
work to change it, so that strangers' programs can be hosted, is in
`docs/dev/security/roadmap.md`, section D.
