import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { herdrReporter } from "./herdr.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

type Received = { id: string; method: string; params: Record<string, any> };

type FakeHerdr = {
  socketPath: string;
  received: Received[];
  stop: () => Promise<void>;
};

const servers: FakeHerdr[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

/** A stand-in for the Herdr server: records each JSON line and answers it. */
async function fakeHerdr(): Promise<FakeHerdr> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-herdr-"));
  const socketPath = path.join(dir, "herdr.sock");
  const received: Received[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as Received;
        received.push(request);
        socket.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const fake = {
    socketPath,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
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

describe("herdrReporter", () => {
  it("sends nothing when HERDR_ENV is not 1", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter({ ...herdrEnv(fake.socketPath), HERDR_ENV: "" });
    reporter.report("working");
    await reporter.release();
    expect(fake.received).toEqual([]);
  });

  it("reports a state for the pane under the agency name", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter(herdrEnv(fake.socketPath));
    reporter.report("blocked", "Approve this write?");
    await reporter.release();
    expect(fake.received[0].method).toBe("pane.report_agent");
    expect(fake.received[0].params).toMatchObject({
      pane_id: "w1:p2",
      source: "agency",
      agent: "agency",
      state: "blocked",
      message: "Approve this write?",
    });
  });

  it("drops a state that was replaced before it could be sent", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter(herdrEnv(fake.socketPath));
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

  it("sends a seq that goes up with every request", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter(herdrEnv(fake.socketPath));
    reporter.report("working");
    await waitFor(() => fake.received.length === 1);
    reporter.report("idle");
    await reporter.release();
    const seqs = fake.received.map((request) => request.params.seq);
    expect(seqs).toHaveLength(3);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
  });

  it("does not send the same report twice in a row", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter(herdrEnv(fake.socketPath));
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
    const reporter = herdrReporter(herdrEnv(fake.socketPath));
    reporter.report("working");
    await waitFor(() => fake.received.length === 1);
    reporter.setSession({ id: "123-456", resumeArgv: ["agency", "agent", "--resume", "123-456"] });
    reporter.report("idle");
    await waitFor(() => fake.received.length === 2);
    expect(fake.received[0].params.agent_session_id).toBeUndefined();
    expect(fake.received[0].params.resume_argv).toBeUndefined();
    expect(fake.received[1].params.agent_session_id).toBe("123-456");
    expect(fake.received[1].params.resume_argv).toEqual(["agency", "agent", "--resume", "123-456"]);
  });

  it("reports blocked while waiting, then working, and returns the answer", async () => {
    const fake = await fakeHerdr();
    const reporter = herdrReporter(herdrEnv(fake.socketPath));
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
    const reporter = herdrReporter(herdrEnv(fake.socketPath + ".missing"));
    reporter.report("working");
    await expect(reporter.release()).resolves.toBeUndefined();
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
