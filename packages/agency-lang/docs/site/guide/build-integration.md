---
name: Build Integration
description: How to compile Agency code as part of a JavaScript build (Vite, etc.) and call it from the backend of a web app.
---

# Build Integration

Agency compiles to plain ESM JavaScript that runs on Node, so it fits neatly into the backend of a web app.

There are two things to set up:

1. Compile `.agency` → `.js` as a step in your build.
2. Import the compiled nodes and call them from your backend.

## The basic idea

A node compiles to an exported async function. Suppose you have:

```ts
// agency/chat.agency
node reply(message: string) {
  return llm(`Reply helpfully to: ${message}`)
}
```

After compiling you can import `reply` from the generated `.js` and call it:

```ts
import { reply } from "./agency/chat.js";

const answer = await reply("How do I reset my password?");
```

Since the compiled file imports the `agency-lang` package at runtime, install it as a project dependency:

```bash
npm install agency-lang
```

See [TypeScript interoperability](/guide/ts-interop) for more info.

## Compiling as a build step

Use `agency compile` to compile a file or directory. See the [compile](/cli/compile) command.

## Example: Wiring it into Vite

Agency nodes run on the server, so the goal here is just to fold `agency compile` into your Vite lifecycle — you don't want to run it by hand in a separate terminal during development, and you don't want stale `.js` in a production build.

A small plugin covers both cases: it recompiles on the fly during `vite dev`, and compiles once (failing the build on error) before `vite build`.

```ts
// vite.config.ts
import { defineConfig, type Plugin } from "vite";
import { spawn, spawnSync } from "node:child_process";

function agency(dir = "agency"): Plugin {
  return {
    name: "agency-compile",
    // `vite build`: compile once up front, and fail the build if it errors.
    buildStart() {
      const { status } = spawnSync("agency", ["compile", dir], {
        stdio: "inherit",
        shell: true,
      });
      if (status !== 0) throw new Error("agency compile failed");
    },
    // `vite dev`: recompile whenever a `.agency` file changes.
    configureServer() {
      spawn("agency", ["compile", "--watch", dir], {
        stdio: "inherit",
        shell: true,
      });
    },
  };
}

export default defineConfig({
  plugins: [agency()],
});
```

The `agency` binary resolves because you installed `agency-lang` as a dependency and Vite runs through an npm script (`npm run dev` / `npm run build`), which puts `node_modules/.bin` on the `PATH`.

This compiles every `.agency` file under `agency/` next to its source (`agency/chat.agency` → `agency/chat.js`). Import the generated node from your server-side code — an API route, SSR handler, or endpoint — and `await` it:

```ts
// server-side only — e.g. an API route handler
import { reply } from "./agency/chat.js";

export async function POST(request: Request) {
  const { message } = await request.json();
  const answer = await reply(message);
  return Response.json({ answer });
}
```

## Alternative: run Agency as a separate service

If you'd rather not couple Agency into your app's build at all, run it as its own service. See [serving Agency code](/guide/serving) for details.

## Usage notes

- **Only nodes are importable**, functions are not.
- **Nodes are async**, so always `await` them.
- **Install `agency-lang`** as a dependency so the compiled output can use it at runtime.