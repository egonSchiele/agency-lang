---
name: Build Integration
description: How to compile Agency code as part of a JavaScript build (Vite, etc.) and call it from the backend of a web app.
---

# Build Integration

Agency compiles to plain ESM JavaScript that runs on Node, so it slots neatly into the **backend** of a web app. You can compile your `.agency` files as part of your normal build and call the compiled nodes straight from your server code — an API route, an SSR handler, an Express server, whatever you're using.

There are really just two things to set up:

1. Compile `.agency` → `.js` as a step in your build.
2. Import the compiled nodes and call them from your backend.

> **Server-side only.** Agency runs on Node and needs your provider API keys (`OPENAI_API_KEY`, etc.) in the environment. Never import Agency code into a browser bundle — that would ship your keys to the client. Keep it on the server.

## The basic idea

A node compiles to an exported async function. If you have:

```ts
// agency/chat.agency
node reply(message: string) {
  return llm(`Reply helpfully to: ${message}`)
}
```

then after compiling you can import `reply` from the generated `.js` and `await` it, exactly as covered in [TypeScript interoperability](/guide/ts-interop):

```ts
import { reply } from "./agency/chat.js";

const answer = await reply("How do I reset my password?");
```

Since the compiled file imports the `agency-lang` package at runtime, install it as a project dependency:

```bash
npm install agency-lang
```

## Compiling as a build step

Use `agency compile` (see the [compile reference](/cli/compile)) to turn a file or a whole directory into `.js`. The easiest approach is to keep your Agency source in its own folder and wire compilation into your npm scripts:

```json
{
  "scripts": {
    "build:agency": "agency compile src/agency",
    "build": "npm run build:agency && vite build",
    "dev": "concurrently \"agency compile src/agency -w\" \"vite\""
  }
}
```

- For production builds, compile once before your bundler runs.
- For development, run `agency compile -w` (watch mode) alongside your dev server so edits recompile automatically. [`concurrently`](https://www.npmjs.com/package/concurrently) or `npm-run-all` are handy for running the two together.

Commit the `.agency` sources; the generated `.js` files are build artifacts, so you'll usually want to `.gitignore` them.

## Wiring it into Vite

There's no dedicated Vite plugin — you don't need one. Treat Agency compilation as a pre-step (the npm scripts above), and then import the compiled nodes **only from server-side code**: a framework's server route (SvelteKit, Nuxt, Next, Astro, …), a Vite SSR entry, or a separate Node/Express backend that your frontend talks to.

A minimal Express handler:

```ts
import express from "express";
import { reply } from "./agency/chat.js";

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  const answer = await reply(req.body.message);
  res.json({ answer });
});

app.listen(3000);
```

Keep `agency-lang` out of your client bundle. Because you're only importing the compiled node from server code, it stays server-side naturally — just don't reference it from a browser component. If your bundler ever tries to pull it in, mark it external (in Vite SSR, leave it in `ssr.external` — the default for dependencies).

## Alternative: run Agency as a separate service

If you'd rather not couple Agency into your app's build at all, run it as its own service and call it over HTTP. `agency serve http` turns exported functions and nodes into a REST API, and `--standalone` emits a self-contained server you can deploy on its own:

```bash
agency serve http src/agency/chat.agency --standalone
```

Your frontend build stays completely Agency-free and just makes `fetch` calls to the service. See [Serving Agency Code](/guide/serving) for the full API, and [`pack`](/cli/pack) if you want a single portable file to drop into a minimal container.

## Gotchas

- **Backend only** — Agency needs Node and your API keys; never bundle it for the browser.
- **Only nodes are importable** from TypeScript — plain `def` functions aren't. Wrap the logic you want to expose in a `node`.
- **Nodes are async** — always `await` them.
- **Install `agency-lang`** as a dependency so the compiled output can find it at runtime.
