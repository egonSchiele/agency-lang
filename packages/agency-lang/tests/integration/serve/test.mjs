// End-to-end test for `agency serve http`: spawn the real CLI server
// against a compiled module and make real HTTP requests over a socket.
//
// This is the regression guard for served *functions*. Generated function
// bodies require an ambient Agency execution frame; the serve adapters used
// to invoke functions cold, so every `POST /function/:name` threw
// "getRuntimeContext() called outside an Agency execution frame". Nodes were
// unaffected. The adapter unit tests use fake JS function bodies that never
// touch the runtime context, so only an end-to-end serve + request reproduces
// it. No LLM calls.

import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  createTempProject, initProject, installTarball,
  writeFile, assert, assertIncludes, cleanup, getTarballPath,
} from "../helpers.mjs";

// Ask the OS for a free TCP port, then hand it to the server. A tiny race
// (port could be taken between close and the server binding) is acceptable
// for a CI integration test and far simpler than parsing the port back out
// of the server's stdout.
function getFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until the server answers GET /list, or fail (printing captured server
// output) if it exits early or never comes up.
async function waitForReady(baseUrl, child, getOutput, deadlineMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server exited early (code ${child.exitCode}) before becoming ready.\n` +
          `--- server output ---\n${getOutput()}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/list`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(
    `Server did not become ready within ${deadlineMs}ms.\n` +
      `--- server output ---\n${getOutput()}`,
  );
}

// SIGTERM, then SIGKILL as a fallback, and wait for the process to actually
// exit so the temp dir can be removed cleanly.
async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((res) => child.once("exit", res));
  child.kill("SIGTERM");
  const killed = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]);
  if (!killed) {
    child.kill("SIGKILL");
    await exited;
  }
}

const tarball = resolve(getTarballPath());
const dir = createTempProject("serve");
let child;

try {
  initProject(dir);
  installTarball(dir, tarball);

  // A `static const` read makes the function body depend on bootstrap init
  // having run inside the execution frame — an uninitialized static read
  // would throw, so this also guards that the frame's globals/statics are set
  // up, not merely that a frame exists.
  writeFile(dir, "greet.agency", `static const GREETING = "Hello"

export def greet(name: string): string {
  return "\${GREETING}, \${name}!"
}

node main() {
  print(greet("world"))
}
`);

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const agencyJs = join(dir, "node_modules", "agency-lang", "dist", "scripts", "agency.js");

  // Spawn the real CLI (the node script directly, so there is a single process
  // to terminate — no npx/shell wrapper subtree to leak).
  let output = "";
  child = spawn(process.execPath, [agencyJs, "serve", "http", "greet.agency", "--port", String(port)], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { output += c; });
  child.stderr.on("data", (c) => { output += c; });

  await waitForReady(baseUrl, child, () => output);

  // --- Test 1: POST /function/greet returns the computed value ---
  console.log("--- Test 1: POST /function/greet ---");
  const fnRes = await fetch(`${baseUrl}/function/greet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "foo" }),
  });
  assert(fnRes.status === 200, `expected 200, got ${fnRes.status}`);
  const fnBody = await fnRes.json();
  assert(
    fnBody.success === true && fnBody.value === "Hello, foo!",
    `unexpected function response: ${JSON.stringify(fnBody)}\n--- server output ---\n${output}`,
  );
  console.log("Test 1 passed");

  // --- Test 2: GET /list advertises greet as a function ---
  console.log("--- Test 2: GET /list ---");
  const listRes = await fetch(`${baseUrl}/list`);
  const listBody = await listRes.json();
  const fnNames = (listBody.functions ?? []).map((f) => f.name);
  assert(fnNames.includes("greet"), `greet not listed; got ${JSON.stringify(fnNames)}`);
  console.log("Test 2 passed");

  // --- Test 3: unknown function is a clean 404, not a crash ---
  console.log("--- Test 3: unknown function 404 ---");
  const missRes = await fetch(`${baseUrl}/function/nope`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert(missRes.status === 404, `expected 404, got ${missRes.status}`);
  console.log("Test 3 passed");

  console.log("=== All serve HTTP tests passed ===");
  await stopServer(child);
  cleanup(dir);
} catch (err) {
  console.error("serve HTTP test failed:", err);
  console.error("Temp directory preserved at:", dir);
  await stopServer(child);
  process.exit(1);
}
