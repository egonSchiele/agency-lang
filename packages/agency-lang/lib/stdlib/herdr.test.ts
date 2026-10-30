import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { herdrReporter } from "./herdr.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

type Received = { id: string; method: string; params: Record<string, any> };

/** What the fake server writes back for a request; null writes nothing. */
type Answer = (request: Received) => object | null;

type FakeHerdr = {
  socketPath: string;
  received: Received[];
  stop: () => Promise<void>;
};

const servers: FakeHerdr[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

const answerOk: Answer = (request) => ({ id: request.id, result: { type: "ok" } });

/** A stand-in for the Herdr server: records each JSON line and answers it. */
async function fakeHerdr(answer: Answer = answerOk): Promise<FakeHerdr> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-herdr-"));
  const socketPath = path.join(dir, "herdr.sock");
  const received: Received[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as Received;
        received.push(request);
        const reply = answer(request);
        if (reply) {
          socket.write(`${JSON.stringify(reply)}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const fake = {
    socketPath,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => {
          safeDeleteDirectoryWithin(os.tmpdir(), dir);
          resolve();
        });
      }),
  };
  servers.push(fake);
  return fake;
}

function herdrEnv(socketPath: string): Record<string, string> {
  return { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p2" };
}

function reporterFor(fake: FakeHerdr) {
  return herdrReporter(herdrEnv(fake.socketPath), "agency");
}

const SESSION = { id: "123-456", resumeArgv: ["agency", "agent", "--resume", "123-456"] };

describe("herdrReporter", () => {
  it("sends nothing when HERDR_ENV is not 1", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter({ ...herdrEnv(fake.socketPath), HERDR_ENV: "" }, "agency");
    reporter.report("working");
    await reporter.release();
    expect(fake.received).toEqual([]);
  });

  it("sends nothing when the program has no Herdr name", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter(herdrEnv(fake.socketPath), "");
    reporter.report("working");
    await reporter.release();
    expect(fake.received).toEqual([]);
  });

  it("reports a state for the pane under the program's name", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter(herdrEnv(fake.socketPath), "my-chat");
    reporter.report("blocked", "Approve this write?");
    await reporter.release();
    expect(fake.received[0].method).toBe("pane.report_agent");
    expect(fake.received[0].params).toMatchObject({
      pane_id: "w1:p2",
      source: "my-chat",
      agent: "my-chat",
      state: "blocked",
      message: "Approve this write?",
    });
  });

  it("drops a state that was replaced before it could be sent", async () => {
    const fake = await fakeHerdr();
    const reporter = reporterFor(fake);
    reporter.report("working");
    reporter.report("blocked", "Approve?");
    reporter.report("idle");
    await reporter.release();
    // "working" was already in flight; "idle" replaced "blocked" in the
    // queue, and the release replaced "idle".
    expect(fake.received.map((request) => request.method)).toEqual([
      "pane.report_agent",
      "pane.release_agent",
    ]);
    expect(fake.received[0].params.state).toBe("working");
  });

  it("gives a restarted reporter a seq above the last one Herdr took", async () => {
    const fake = await fakeHerdr();
    const first = reporterFor(fake);
    first.report("working");
    first.report("idle");
    await first.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const restarted = reporterFor(fake);
    restarted.report("working");
    await restarted.release();
    const seqs = fake.received.map((request) => request.params.seq);
    expect(seqs).toHaveLength(4);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
    expect(seqs[3]).toBeGreaterThan(seqs[2]);
  });

  it("does not send the same report twice in a row", async () => {
    const fake = await fakeHerdr();
    const reporter = reporterFor(fake);
    reporter.report("idle");
    await waitFor(() => fake.received.length === 1);
    reporter.report("idle");
    await reporter.release();
    expect(fake.received.map((request) => request.method)).toEqual([
      "pane.report_agent",
      "pane.release_agent",
    ]);
  });

  it("sends the session and its resume command with every report after it is set", async () => {
    const fake = await fakeHerdr();
    const reporter = reporterFor(fake);
    reporter.report("working");
    await waitFor(() => fake.received.length === 1);
    reporter.setSession(SESSION);
    reporter.report("idle");
    await waitFor(() => fake.received.length === 2);
    expect(fake.received[0].params.agent_session_id).toBeUndefined();
    expect(fake.received[0].params.resume_argv).toBeUndefined();
    expect(fake.received[1].params.agent_session_id).toBe("123-456");
    expect(fake.received[1].params.resume_argv).toEqual(SESSION.resumeArgv);
  });

  it("keeps reporting states after Herdr refuses the resume command", async () => {
    const fake = await fakeHerdr((request) => {
      if (request.params.resume_argv) {
        return { id: request.id, error: { code: "invalid_resume_argv", message: "refused" } };
      }
      return answerOk(request);
    });
    const reporter = reporterFor(fake);
    reporter.setSession(SESSION);
    reporter.report("idle");
    await waitFor(() => fake.received.length === 2);
    reporter.report("working");
    await reporter.release();
    const states = fake.received.map((request) => [
      request.params.state,
      !!request.params.resume_argv,
    ]);
    expect(states).toEqual([
      ["idle", true],
      ["idle", false],
      ["working", false],
      [undefined, false],
    ]);
  });

  it("reports blocked while waiting, then working, and returns the answer", async () => {
    const fake = await fakeHerdr();
    const reporter = reporterFor(fake);
    const answer = await reporter.whileBlocked("Approve?", async () => {
      await waitFor(() => fake.received.length === 1);
      return "yes";
    });
    await waitFor(() => fake.received.length === 2);
    expect(answer).toBe("yes");
    expect(fake.received.map((request) => request.params.state)).toEqual(["blocked", "working"]);
  });

  it("finishes a release when nothing is listening on the socket", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter(herdrEnv(fake.socketPath + ".missing"), "agency");
    reporter.report("working");
    await expect(reporter.release()).resolves.toBeUndefined();
  });

  it("finishes a release when Herdr accepts the connection and never answers", async () => {
    const fake = await fakeHerdr(() => null);
    const reporter = reporterFor(fake);
    reporter.report("working");
    const started = Date.now();
    await reporter.release();
    // Two requests, each given up on after the 500 ms timeout.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(fake.received).toHaveLength(2);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the fake Herdr server");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
