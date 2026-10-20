// The run side's socket server, on a real socket in a temporary sessions
// directory. The program behind it is a compiled fixture, as in
// attach.test.ts.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { compile } from "@/compiler/defaultSession.js";
import { TestDebuggerIO, fixtureDir, freshImport } from "../testHelpers.js";
import { lineChannel } from "./lineChannel.js";
import type { Hello } from "./protocol.js";
import { ensureSessionsDir, recordPaths, type AttachRecord } from "./registry.js";
import { startAttachServer, type AttachServer } from "./server.js";
import { serveDebuggerIO } from "./serveIO.js";

const fixtureAgency = path.join(fixtureDir, "step-test.agency");
const fixtureCompiled = path.join(fixtureDir, "step-test.ts");

beforeAll(() => {
  compile({}, fixtureAgency, fixtureCompiled, { ts: true });
});

function functionsOf(mod: any) {
  return {
    respondToInterrupts: mod.respondToInterrupts,
    rewindFrom: mod.rewindFrom,
    __setDebugger: mod.__setDebugger,
    __getCheckpoints: mod.__getCheckpoints,
  };
}

async function connect(sock: string) {
  const socket = net.connect(sock);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  return lineChannel(socket);
}

describe("the attach server", () => {
  let dir: string;
  let record: AttachRecord;
  let server: AttachServer | null = null;

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-")), "debug-sessions");
    ensureSessionsDir(dir);
    record = { pid: process.pid, program: "agent.agency", node: "main", startedAt: Date.now() };
  });
  afterEach(async () => {
    await server?.stop();
    server = null;
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("listens on <pid>.sock with mode 600, replacing a leftover socket", async () => {
    const mod = await freshImport(fixtureCompiled);
    const sock = recordPaths(dir, record.pid).sock;
    fs.writeFileSync(sock, "leftover");
    const started = await startAttachServer({ dir, record, functions: functionsOf(mod) });
    expect("unavailable" in started).toBe(false);
    server = started as AttachServer;
    expect(server.socketPath).toBe(sock);
    expect(fs.statSync(sock).isSocket()).toBe(true);
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    await server.stop();
    server = null;
    expect(fs.existsSync(sock)).toBe(false);
  });

  it("refuses a socket path the platform cannot take", async () => {
    const mod = await freshImport(fixtureCompiled);
    const longDir = path.join(dir, "x".repeat(120));
    const started = await startAttachServer({ dir: longDir, record, functions: functionsOf(mod) });
    expect(started).toMatchObject({ unavailable: expect.stringContaining("over the 104") });
  });

  it("drives the program from a client, refuses a second client, and says when it ends", async () => {
    const mod = await freshImport(fixtureCompiled);
    const started = await startAttachServer({ dir, record, functions: functionsOf(mod) });
    server = started as AttachServer;

    const first = await connect(server.socketPath);
    const io = new TestDebuggerIO([{ type: "step" }, { type: "continue" }]);
    const hellos: Hello[] = [];
    const finished: unknown[] = [];
    const helloSeen = new Promise<void>((resolve) =>
      serveDebuggerIO(first, io, {
        hello: (message) => {
          hellos.push(message);
          resolve();
        },
        finished: (value) => finished.push(value),
      }),
    );
    await helloSeen;
    expect(server.current()).not.toBeNull();

    const second = await connect(server.socketPath);
    const refused = await new Promise<string>((resolve) =>
      serveDebuggerIO(second, new TestDebuggerIO([]), { refused: resolve }),
    );
    expect(refused).toMatch(/^already attached since /);

    const closedByRun = new Promise<void>((resolve) => first.onClose(resolve));
    const result = await mod.main();
    await closedByRun;

    expect(result.data).toBe(3);
    expect(hellos).toEqual([
      { type: "hello", program: "agent.agency", node: "main", pid: process.pid },
    ]);
    expect(io.renderCalls.length).toBeGreaterThanOrEqual(2);
    expect(finished).toEqual([3]);
    expect(server.current()).toBeNull();
  });
});
