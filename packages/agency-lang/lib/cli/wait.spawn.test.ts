// End to end: the built command line running a program with
// `--wait-for-response`, and a client on its socket doing what `agency
// attach` does. The programs have no terminal here, which is the case the
// flag exists for. Each test waits on a file the program writes or on a
// message from it, never on a clock.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";

import type { HeldMessage } from "@/debugger/attach/protocol.js";
import { approve, reject } from "@/runtime/interruptResponse.js";
import {
  CLI,
  fixtureFolder,
  socketClient,
  startCli,
  throwawayHome,
  waitFor,
  waitForFile,
  waitForSocket,
  watchClient,
  type StartedCli,
  type TestClient,
  type Throwaway,
} from "./spawnTestHelpers.js";

/** Long enough to compile a program and start it. */
const START_MS = 60_000;
const TEST_MS = 120_000;

// Writes a marker, asks, and writes a second marker, or the reason it was
// refused. Its own writes are approved in the program, so the only
// question nobody settles is `test::ask`.
const ASKS = `effect test::ask { label: string }

def ask(): string {
  return interrupt test::ask("May I open the door?", { label: "door" })
  return "opened"
}

node main() {
  write(filename: "started.txt", content: "1", dir: ".") with approve
  const answer = ask()
  if (isFailure(answer)) {
    write(filename: "rejected.txt", content: answer.error, dir: ".") with approve
  } else {
    write(filename: "finished.txt", content: "1", dir: ".") with approve
  }
}
`;

const ASKS_FOR_VALUE = `effect test::pick { options: string }

node main() {
  write(filename: "started.txt", content: "1", dir: ".") with approve
  const colour = interrupt test::pick("Which colour?", { options: "any" })
  write(filename: "answer.txt", content: "\${colour}", dir: ".") with approve
}
`;

const SAVE_CHECKPOINTS = JSON.stringify({
  spawn: { interrupts: { preemptivelyCreateCheckpoint: true } },
});

const isHeld = (message: { type: string }): message is HeldMessage => message.type === "held";
const holdsSomething = (message: { type: string }): boolean =>
  isHeld(message) && message.questions.length > 0;

describe.skipIf(!existsSync(CLI))("agency run --wait-for-response (end-to-end)", () => {
  let home: Throwaway;
  let fixture: Throwaway;
  let started: StartedCli[] = [];
  let clients: TestClient[] = [];

  function setUp(files: Record<string, string>): void {
    home = throwawayHome();
    fixture = fixtureFolder(".agency-wait-spawn-", files);
  }
  function run(args: string[]): StartedCli {
    const cli = startCli(fixture.dir, args, { AGENCY_HOME: home.dir });
    started.push(cli);
    onTestFailed(() => console.log(`agency ${args.join(" ")} wrote:\n${cli.output()}`));
    return cli;
  }
  async function watching(known: string[] = []): Promise<{ sock: string; client: TestClient }> {
    const sock = await waitForSocket(home.dir, START_MS, known);
    const client = await watchClient(sock, START_MS);
    clients.push(client);
    return { sock, client };
  }
  const file = (name: string): string => path.join(fixture.dir, name);
  /** The one held question, once the program holds it. */
  async function heldQuestion(client: TestClient) {
    const held = (await client.next(holdsSomething, 0, START_MS)) as HeldMessage;
    expect(held.questions).toHaveLength(1);
    return held.questions[0]!;
  }

  afterEach(() => {
    for (const client of clients) client.close();
    for (const cli of started) cli.stop();
    clients = [];
    started = [];
    fixture.remove();
    home.remove();
  });

  it(
    "holds a question nobody settled: the program is alive and has not gone on",
    async () => {
      setUp({ "asks.agency": ASKS });
      const cli = run(["run", "--wait-for-response", "asks.agency"]);
      const { client } = await watching();
      const question = await heldQuestion(client);

      expect(question).toMatchObject({
        effect: "test::ask",
        message: "May I open the door?",
        data: { label: "door" },
      });
      expect(existsSync(file("started.txt"))).toBe(true);
      expect(existsSync(file("finished.txt"))).toBe(false);
      expect(existsSync(file("rejected.txt"))).toBe(false);
      expect(cli.child.exitCode).toBeNull();
      await waitFor(() => cli.output().includes("agency attach"), START_MS, "the notice");
      expect(cli.output()).toContain("Waiting for an answer to 1 question");
      // The setting is off, so no checkpoint was saved.
      expect(existsSync(path.join(home.dir, "held"))).toBe(false);
    },
    TEST_MS,
  );

  it(
    "goes on when the question is approved",
    async () => {
      setUp({ "asks.agency": ASKS });
      const cli = run(["run", "--wait-for-response", "asks.agency"]);
      const { client } = await watching();
      const question = await heldQuestion(client);
      client.channel.send({
        type: "answers",
        answers: [{ interruptId: question.interruptId, response: approve() }],
      });
      await waitForFile(file("finished.txt"), START_MS);
      expect(await cli.exited).toBe(0);
      expect(existsSync(file("rejected.txt"))).toBe(false);
    },
    TEST_MS,
  );

  it(
    "hands the program a rejection with its reason",
    async () => {
      setUp({ "asks.agency": ASKS });
      run(["run", "--wait-for-response", "asks.agency"]);
      const { client } = await watching();
      const question = await heldQuestion(client);
      client.channel.send({
        type: "answers",
        answers: [{ interruptId: question.interruptId, response: reject("the door stays shut") }],
      });
      await waitForFile(file("rejected.txt"), START_MS);
      expect(readFileSync(file("rejected.txt"), "utf8")).toContain("the door stays shut");
      expect(existsSync(file("finished.txt"))).toBe(false);
    },
    TEST_MS,
  );

  // An approve rule must not answer a raise that expects a value with no
  // value: a person can supply one through attach.
  it(
    "still holds a raise that expects a value under an approve rule, and delivers the value",
    async () => {
      setUp({ "asks.agency": ASKS_FOR_VALUE });
      run(["run", "--wait-for-response", "--approve", "test::pick", "asks.agency"]);
      const { client } = await watching();
      const question = await heldQuestion(client);
      expect(question.expectsValue).toBe(true);
      expect(existsSync(file("answer.txt"))).toBe(false);
      client.channel.send({
        type: "answers",
        answers: [{ interruptId: question.interruptId, response: approve("teal") }],
      });
      await waitForFile(file("answer.txt"), START_MS);
      expect(readFileSync(file("answer.txt"), "utf8")).toBe("teal");
    },
    TEST_MS,
  );

  it(
    "keeps holding when a client leaves without answering",
    async () => {
      setUp({ "asks.agency": ASKS });
      const cli = run(["run", "--wait-for-response", "asks.agency"]);
      const first = await watching();
      await heldQuestion(first.client);
      first.client.close();

      const second = await watchClient(first.sock, START_MS);
      clients.push(second);
      await heldQuestion(second);
      expect(cli.child.exitCode).toBeNull();
      expect(existsSync(file("finished.txt"))).toBe(false);
      expect(existsSync(file("rejected.txt"))).toBe(false);
    },
    TEST_MS,
  );

  it(
    "saves the held checkpoint when the setting is on, and a resume from it holds again",
    async () => {
      setUp({ "asks.agency": ASKS, "agency.json": SAVE_CHECKPOINTS });
      const first = run(["run", "--wait-for-response", "asks.agency"]);
      const before = await watching();
      await heldQuestion(before.client);
      const heldDir = path.join(home.dir, "held");
      const saved = readdirSync(heldDir);
      expect(saved).toHaveLength(1);
      const checkpoint = path.join(heldDir, saved[0]!);
      // The notice names the file by its real path (`/tmp` is a link on macOS).
      const resumeLine = `agency resume ${realpathSync(checkpoint)}`;
      await waitFor(() => first.output().includes(resumeLine), START_MS, "the resume line");

      // The process dies while holding. Its checkpoint file stays.
      before.client.close();
      first.stop();
      await first.exited;
      expect(existsSync(checkpoint)).toBe(true);

      run(["resume", "--wait-for-response", checkpoint, "asks.agency"]);
      const after = await watching([before.sock]);
      const question = await heldQuestion(after.client);
      expect(question.effect).toBe("test::ask");
      after.client.channel.send({
        type: "answers",
        answers: [{ interruptId: question.interruptId, response: approve() }],
      });
      await waitForFile(file("finished.txt"), START_MS);
    },
    TEST_MS,
  );

  it(
    "refuses -i together with --wait-for-response, naming both",
    async () => {
      setUp({ "asks.agency": ASKS });
      const cli = run(["run", "-i", "--wait-for-response", "asks.agency"]);
      expect(await cli.exited).not.toBe(0);
      expect(cli.output()).toContain("--wait-for-response");
      expect(cli.output()).toContain("--interactive");
      expect(existsSync(file("started.txt"))).toBe(false);
    },
    TEST_MS,
  );

  // `--interactive` did not change: with no terminal it rejects, on purpose.
  it(
    "still rejects under -i when there is no terminal",
    async () => {
      setUp({ "asks.agency": ASKS });
      const cli = run(["run", "-i", "asks.agency"]);
      expect(await cli.exited).toBe(0);
      expect(existsSync(file("rejected.txt"))).toBe(true);
      expect(existsSync(file("finished.txt"))).toBe(false);
    },
    TEST_MS,
  );

  it(
    "gives a debugger its session on a holding program, and still serves a watching client",
    async () => {
      setUp({ "asks.agency": ASKS });
      run(["run", "--wait-for-response", "asks.agency"]);
      const { sock, client } = await watching();
      await heldQuestion(client);

      const debuggerClient = await socketClient(sock, "cli", START_MS);
      clients.push(debuggerClient);
      await debuggerClient.next((message) => message.type === "hello", 0, START_MS);

      const second = await watchClient(sock, START_MS);
      clients.push(second);
      await heldQuestion(second);
    },
    TEST_MS,
  );
});
