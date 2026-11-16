// End to end: an Agency program that calls `spawn`, run with the built
// command line. The spawned program outlives its caller, so each test
// waits on a file it writes or on a message from its socket. No test
// signals a pid it read from output: every program here ends by itself,
// is answered so that it ends, or reaches its own deadline.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";

import type { HeldMessage } from "@/debugger/attach/protocol.js";
import { approve } from "@/runtime/interruptResponse.js";
import { watch } from "./attachWatch.js";
import { outputFollower } from "./outputFollower.js";
import {
  ASKS,
  CLI,
  SEED,
  WRITES_THREAD,
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

const START_MS = 60_000;
const TEST_MS = 120_000;

// Spawns the program named by its first argument, under the policy and
// with the messages given as JSON in the next two, and prints the result.
// Its `with approve` approves the start and nothing the program does.
const CALLER = `import { spawn } from "std::agency"
import { args } from "std::system"

node main() {
  const argv = args()
  const policy = JSON.parse(argv[1])
  const messages = JSON.parse(argv[2])
  const result = spawn(".", argv[0], policy: policy, messages: messages) with approve
  if (result is failure(err)) {
    print("SPAWN_FAILED:" + err)
  } else {
    print("SPAWNED:" + JSON.stringify(result.value))
  }
}
`;

const MARKS = `node main() {
  print("a line from the spawned program")
  write(filename: "marked.txt", content: "1", dir: ".") with approve
}
`;

const LOGS_TO_A_FILE = JSON.stringify({ observability: true, log: { logFile: "statelog.jsonl" } });
const APPROVES_ASK = JSON.stringify({ "test::ask": [{ action: "approve" }] });

type Spawned = { pid: number; name: string; outputFile: string };

describe.skipIf(!existsSync(CLI))("spawn (end-to-end)", () => {
  let home: Throwaway;
  let fixture: Throwaway;
  let started: StartedCli[] = [];
  let clients: TestClient[] = [];

  function setUp(files: Record<string, string>): void {
    home = throwawayHome();
    fixture = fixtureFolder(".agency-spawn-spawn-", { "caller.agency": CALLER, ...files });
  }
  const file = (name: string): string => path.join(fixture.dir, name);

  /** Run the caller to its end, and return what `spawn` gave it. */
  async function spawnFromCaller(
    program: string,
    policy: string = "{}",
    messages: string = "[]",
    env: NodeJS.ProcessEnv = {},
  ): Promise<Spawned> {
    const cli = startCli(fixture.dir, ["run", "caller.agency", "--", program, policy, messages], {
      AGENCY_HOME: home.dir,
      ...env,
    });
    started.push(cli);
    onTestFailed(() => console.log(`the caller wrote:\n${cli.output()}`));
    expect(await cli.exited).toBe(0);
    const line = cli
      .output()
      .split("\n")
      .find((text) => text.startsWith("SPAWNED:"));
    expect(line, cli.output()).toBeDefined();
    const spawned = JSON.parse(line!.slice("SPAWNED:".length)) as Spawned;
    onTestFailed(() => {
      if (existsSync(spawned.outputFile)) {
        console.log(`the spawned program wrote:\n${readFileSync(spawned.outputFile, "utf8")}`);
      }
    });
    return spawned;
  }
  const outputOf = (spawned: Spawned): string => readFileSync(spawned.outputFile, "utf8");
  const isHolding = (message: { type: string }): boolean =>
    message.type === "held" && (message as HeldMessage).questions.length > 0;

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const cli of started) cli.stop();
    await Promise.all(started.map((cli) => cli.exited));
    clients = [];
    started = [];
    fixture.remove();
    home.remove();
  });

  it(
    "starts a program that outlives its caller, and saves what it prints",
    async () => {
      setUp({ "marks.agency": MARKS });
      const spawned = await spawnFromCaller("marks.agency");
      // The caller has exited by now.
      expect(spawned.pid).toBeGreaterThan(0);
      expect(spawned.name).toBe("marks.agency");
      expect(spawned.outputFile.startsWith(path.join(home.dir, "spawned"))).toBe(true);
      await waitForFile(file("marked.txt"), START_MS);
      await waitFor(
        () => outputOf(spawned).includes("a line from the spawned program"),
        START_MS,
        "the spawned program's line in its output file",
      );
      // The policy had no rules, so no policy file was ever written.
      expect(readdirSync(path.dirname(spawned.outputFile))).toEqual(["output.log"]);
    },
    TEST_MS,
  );

  it(
    "runs the program under the policy it was given",
    async () => {
      setUp({ "asks.agency": ASKS });
      const spawned = await spawnFromCaller("asks.agency", APPROVES_ASK);
      await waitForFile(file("finished.txt"), START_MS);
      // The policy file was for the command that started the program, and
      // is gone once that command has read it.
      expect(readdirSync(path.dirname(spawned.outputFile))).toEqual(["output.log"]);
    },
    TEST_MS,
  );

  // The caller's `with approve` covers the start only. With no rule of its
  // own, the program holds its question for a person.
  it(
    "holds a question its own policy does not settle, under its title, until attach answers",
    async () => {
      setUp({ "asks.agency": ASKS });
      const spawned = await spawnFromCaller("asks.agency");
      const sock = await waitForSocket(home.dir, START_MS);
      const client = await watchClient(sock, START_MS);
      clients.push(client);
      const held = (await client.next(isHolding, 0, START_MS)) as HeldMessage;
      expect(held.questions[0]).toMatchObject({ effect: "test::ask", data: { label: "door" } });
      expect(existsSync(file("started.txt"))).toBe(true);
      expect(existsSync(file("finished.txt"))).toBe(false);
      expect(existsSync(file("rejected.txt"))).toBe(false);

      const shown = execFileSync("ps", ["-p", String(spawned.pid), "-o", "command="], {
        encoding: "utf8",
      });
      expect(shown.trim().startsWith("agency run asks.agency")).toBe(true);
      expect(path.basename(sock)).toBe(`${spawned.pid}.sock`);

      client.channel.send({
        type: "answers",
        answers: [{ interruptId: held.questions[0]!.interruptId, response: approve() }],
      });
      await waitForFile(file("finished.txt"), START_MS);
    },
    TEST_MS,
  );

  it(
    "agency attach prints the program's earlier output and answers its question",
    async () => {
      setUp({ "asks.agency": ASKS });
      const spawned = await spawnFromCaller("asks.agency");
      const sock = await waitForSocket(home.dir, START_MS);
      // The connection `agency attach` makes, with a scripted answer in
      // place of the terminal prompt.
      const attach = await socketClient(sock, "watch", START_MS);
      clients.push(attach);
      let printed = "";
      const asked: string[] = [];
      void watch({
        channel: attach.channel,
        out: () => {},
        decide: async (interrupt) => {
          asked.push(interrupt.effect);
          return approve();
        },
        output: outputFollower(spawned.outputFile, (text) => (printed += text)),
      });
      await waitForFile(file("finished.txt"), START_MS);
      expect(asked).toEqual(["test::ask"]);
      expect(printed).toContain("about to ask");
    },
    TEST_MS,
  );

  it(
    "seeds the program's first thread, and writes the messages to no file of its own",
    async () => {
      setUp({ "writesThread.agency": WRITES_THREAD });
      const spawned = await spawnFromCaller("writesThread.agency", "{}", JSON.stringify(SEED));
      await waitForFile(file("thread.json"), START_MS);
      expect(readFileSync(file("thread.json"), "utf8")).toContain("the seed question");
      const folder = path.dirname(spawned.outputFile);
      for (const name of readdirSync(folder)) {
        expect(readFileSync(path.join(folder, name), "utf8")).not.toContain("the seed question");
      }
    },
    TEST_MS,
  );

  it(
    "gives the program a trace of its own",
    async () => {
      setUp({ "marks.agency": MARKS, "agency.json": LOGS_TO_A_FILE });
      await spawnFromCaller("marks.agency", "{}", "[]", { AGENCY_TRACE_ID: "the-callers-trace" });
      await waitForFile(file("marked.txt"), START_MS);
      const traces = (): string[] =>
        readFileSync(file("statelog.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => (JSON.parse(line) as { trace_id: string }).trace_id);
      await waitFor(
        () => traces().some((trace) => trace !== "the-callers-trace"),
        START_MS,
        "an event from the spawned program",
      );
      expect(traces()).toContain("the-callers-trace");
    },
    TEST_MS,
  );
});
