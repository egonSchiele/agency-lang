import { describe, it, expect, afterEach } from "vitest";
import {
  commandTitle,
  createTerminalStatus,
  installTerminalStatus,
  sanitizeTitle,
  type TerminalStatus,
} from "@/cli/terminalStatus.js";
import { AGENCY_NO_TERM_STATUS, AGENCY_TERM_STATUS_OWNED } from "@/constants.js";
import { Command } from "@/vendor/commander/index.js";

const PUSH = "\x1b[22;0t";
const POP = "\x1b[23;0t";
const WORKING = "\x1b]9;4;3;0\x1b\\";
const CLEAR = "\x1b]9;4;0;0\x1b\\";
const ERROR = "\x1b]9;4;2;0\x1b\\";

/** A status writing into a string buffer, on a terminal we can turn on and off. */
function harness(options: { env?: NodeJS.ProcessEnv; isTty?: boolean } = {}): {
  status: TerminalStatus;
  written: () => string;
  env: NodeJS.ProcessEnv;
} {
  let buffer = "";
  const env = options.env ?? {};
  const status = createTerminalStatus({
    write: (text) => {
      buffer += text;
    },
    env,
    isTty: () => options.isTty ?? true,
  });
  return { status, written: () => buffer, env };
}

describe("createTerminalStatus", () => {
  it("names the tab and starts the spinner", () => {
    const { status, written } = harness();
    status.begin("agency eval run fib");
    expect(written()).toBe(`${PUSH}\x1b]1;agency eval run fib\x07${WORKING}`);
  });

  it("clears the spinner and gives the tab its old name back on success", () => {
    const { status, written } = harness();
    status.begin("agency run x");
    status.end(true);
    expect(written().endsWith(`${CLEAR}${POP}`)).toBe(true);
  });

  it("leaves the indicator in the error state on failure", () => {
    const { status, written } = harness();
    status.begin("agency run x");
    status.end(false);
    expect(written().endsWith(`${ERROR}${POP}`)).toBe(true);
  });

  it("claims the tab so nested agency processes stay quiet", () => {
    const { status, env } = harness();
    status.begin("agency run x");
    expect(env[AGENCY_TERM_STATUS_OWNED]).toBe("1");
  });

  it("writes nothing when an outer process already claimed the tab", () => {
    const { status, written } = harness({ env: { [AGENCY_TERM_STATUS_OWNED]: "1" } });
    status.begin("agency run x");
    status.end(true);
    expect(written()).toBe("");
  });

  it.each([
    ["NO_COLOR", { NO_COLOR: "1" }],
    ["AGENCY_NO_TERM_STATUS", { [AGENCY_NO_TERM_STATUS]: "1" }],
  ])("writes nothing when %s is set", (_name, env) => {
    const { status, written } = harness({ env });
    status.begin("agency run x");
    expect(written()).toBe("");
  });

  it("treats an empty opt-out variable as unset, matching the NO_COLOR convention", () => {
    const { status, written } = harness({ env: { NO_COLOR: "" } });
    status.begin("agency run x");
    expect(written()).not.toBe("");
  });

  it("writes nothing when stdout is not a terminal", () => {
    const { status, written } = harness({ isTty: false });
    status.begin("agency run x");
    expect(written()).toBe("");
  });

  it("does not pop a title it never pushed", () => {
    const { status, written } = harness({ isTty: false });
    status.begin("agency run x");
    status.end(false);
    status.stopProgress();
    expect(written()).toBe("");
  });

  it("ends only once, so a signal followed by exit does not pop twice", () => {
    const { status, written } = harness();
    status.begin("agency run x");
    status.end(false);
    const afterFirstEnd = written();
    status.end(true);
    expect(written()).toBe(afterFirstEnd);
  });

  it("stops the spinner but keeps the name for a full-screen view", () => {
    const { status, written } = harness();
    status.begin("agency logs view");
    const afterBegin = written();
    status.stopProgress();
    expect(written()).toBe(`${afterBegin}${CLEAR}`);
  });

  it("skips a title that sanitizes away to nothing", () => {
    const { status, written } = harness();
    status.begin("\x07\x1b");
    expect(written()).toBe("");
  });
});

describe("sanitizeTitle", () => {
  it("drops control characters that would end the escape sequence early", () => {
    expect(sanitizeTitle("run \x07evil\x1b]2;window\x07")).toBe("run evil]2;window");
  });

  it("drops C1 control characters", () => {
    expect(sanitizeTitle("run \x9bfoo")).toBe("run foo");
  });

  it("truncates a very long title", () => {
    expect(sanitizeTitle("x".repeat(200))).toHaveLength(80);
  });
});

describe("commandTitle", () => {
  /** A program shaped like the real CLI, parsed so commander fills in `args`. */
  function parse(argv: string[]): Command {
    let seen: Command | undefined;
    const program = new Command();
    program.name("agency").exitOverride();
    const remember = (_operand: string | undefined, _options: unknown, command: Command): void => {
      seen = command;
    };
    program.command("eval").command("run").argument("[test]").action(remember);
    program.command("run").argument("<input>").action(remember);
    program.parse(["node", "agency", ...argv]);
    if (seen === undefined) throw new Error("no command ran");
    return seen;
  }

  it("reads as the command that was typed", () => {
    expect(commandTitle(parse(["eval", "run", "fib"]))).toBe("agency eval run fib");
  });

  it("omits an absent operand", () => {
    expect(commandTitle(parse(["eval", "run"]))).toBe("agency eval run");
  });

  it("shortens a path operand to its filename", () => {
    expect(commandTitle(parse(["run", "tests/agency/foo.agency"]))).toBe("agency run foo.agency");
  });
});

describe("installTerminalStatus", () => {
  type ProcessSignal = "exit" | "SIGINT" | "SIGTERM";
  const signals: ProcessSignal[] = ["exit", "SIGINT", "SIGTERM"];
  const before: Record<ProcessSignal, unknown[]> = {
    exit: process.listeners("exit"),
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  };

  // The wiring installs process-level listeners. Take back out whatever this
  // test added, so it does not leak into the rest of the run.
  afterEach(() => {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  });

  it("names the tab from the command that is about to run", async () => {
    const begun: string[] = [];
    const status: TerminalStatus = {
      begin: (title) => begun.push(title),
      end: () => {},
      stopProgress: () => {},
    };
    const program = new Command();
    program.name("agency").exitOverride();
    program
      .command("eval")
      .command("run")
      .argument("[test]")
      .action(() => {});
    installTerminalStatus(program, status);

    await program.parseAsync(["node", "agency", "eval", "run", "fib"]);

    expect(begun).toEqual(["agency eval run fib"]);
  });
});
