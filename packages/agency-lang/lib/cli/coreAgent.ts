// SPIKE: `agency agent --core`, a terminal front-end over the shared session
// core (stdlib/agents/session.agency). It answers the core's interrupts at
// the terminal: the next message, and every approval the policy leaves open.
// `/handoff` writes the paused session to a handoff file for another
// front-end (the Perry app) and exits; `--handoff <file>` picks one up.
import path from "node:path";
import { rmSync } from "node:fs";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { approve, hasInterrupts, reject } from "@/runtime/index.js";
import type { AgencyCallbacks, Interrupt, InterruptResponse } from "@/runtime/index.js";
import { resolveRunPolicy } from "./runPolicy.js";
import {
  SESSION_CORE,
  readHandoff,
  writeHandoff,
  type HandoffFile,
  type HandoffItem,
} from "./handoffFile.js";

const USER_MESSAGE = "agentSession::userMessage";
const DEFAULT_MODEL = "claude-sonnet-5-5";
const DEFAULT_PROVIDER = "anthropic";

type RunResult = { data: unknown };
type RunOptions = { callbacks: AgencyCallbacks; policy: Record<string, unknown> };
type CoreModule = {
  main: (cwd: string, model: string, provider: string, opts: RunOptions) => Promise<RunResult>;
  respondToInterrupts: (
    interrupts: Interrupt[],
    responses: InterruptResponse[],
    opts: { callbacks: AgencyCallbacks; invocation: { policy: Record<string, unknown> } },
  ) => Promise<RunResult>;
};

type CoreArgs = { handoff: string | null; model: string; provider: string };

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string): string => `\x1b[36m${text}\x1b[0m`;
const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;
const yellow = (text: string): string => `\x1b[33m${text}\x1b[0m`;

function parseCoreArgs(args: string[]): CoreArgs {
  const valueOf = (flag: string): string | null => {
    const index = args.indexOf(flag);
    return index === -1 ? null : (args[index + 1] ?? null);
  };
  return {
    handoff: valueOf("--handoff"),
    model: valueOf("--model") ?? DEFAULT_MODEL,
    provider: valueOf("--provider") ?? DEFAULT_PROVIDER,
  };
}

async function loadCore(): Promise<CoreModule> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // SPIKE: the front-end is compiled by `make agents`, after lib/, so it
  // can't be a static import. runBundledAgent spawns its agent instead; a
  // real version would do the same or ship the driver beside the agent.
  // eslint-disable-next-line no-restricted-syntax
  return (await import(path.resolve(here, "../agents/agency-agent/core.js"))) as CoreModule;
}

/** The recommended policy for `cwd`, with the core's message pause always
 *  handed to us: a `*` rule must not answer it. */
function policyFor(cwd: string): Record<string, unknown> {
  const base = resolveRunPolicy({ policy: "recommended", cwd })?.policy ?? {};
  return { ...base, [USER_MESSAGE]: [{ action: "propagate" }] };
}

function firstLine(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Prints what the session reports, and keeps it for a later handoff. */
function makeCallbacks(transcript: HandoffItem[]): AgencyCallbacks {
  const show = (item: HandoffItem, printed: string): void => {
    transcript.push(item);
    console.log(printed);
  };
  return {
    onEmit: (data: Record<string, unknown>) => {
      if (data.type === "agentSession.reply") {
        show({ role: "assistant", text: String(data.text) }, `\n${String(data.text)}\n`);
      } else if (data.type === "agentSession.error") {
        show({ role: "error", text: String(data.message) }, red(String(data.message)));
      } else if (data.type === "agentSession.budgetStop") {
        const text = `The ${String(data.dimension)} budget for ${String(data.label)} ran out.`;
        show({ role: "notice", text }, yellow(text));
      }
    },
    onToolCallStart: (data: { toolName: string; args: Record<string, unknown> }) => {
      const text = `${data.toolName} ${firstLine(Object.values(data.args)[0] ?? "", 60)}`;
      show({ role: "tool", text }, dim(`⏺ ${text}`));
    },
  } as AgencyCallbacks;
}

function replay(transcript: HandoffItem[]): void {
  for (const item of transcript) {
    if (item.role === "user") console.log(cyan(`> ${item.text}`));
    else if (item.role === "tool") console.log(dim(`⏺ ${item.text}`));
    else if (item.role === "error") console.log(red(item.text));
    else if (item.role === "notice") console.log(yellow(item.text));
    else console.log(`\n${item.text}\n`);
  }
}

async function askApprovals(
  rl: readline.Interface,
  interrupts: Interrupt[],
): Promise<InterruptResponse[]> {
  const responses: InterruptResponse[] = [];
  for (const interrupt of interrupts) {
    console.log(yellow(`\n${interrupt.message}`));
    console.log(dim(`${interrupt.effect} ${JSON.stringify(interrupt.data ?? {}, null, 2)}`));
    const answer = (await rl.question(yellow("Allow? (y/n) "))).trim().toLowerCase();
    responses.push(answer === "y" || answer === "yes" ? approve() : reject());
  }
  return responses;
}

function handOff(args: {
  interrupts: Interrupt[];
  transcript: HandoffItem[];
  cwd: string;
  coreArgs: CoreArgs;
}): void {
  const handoff: HandoffFile = {
    version: 1,
    core: SESSION_CORE,
    cwd: args.cwd,
    model: args.coreArgs.model,
    provider: args.coreArgs.provider,
    from: "terminal",
    createdAt: new Date().toISOString(),
    interrupts: args.interrupts,
    transcript: args.transcript,
  };
  const file = writeHandoff(handoff);
  console.log(cyan(`\nHanded off. The session is in ${file}`));
  console.log(
    dim("Perry picks it up from there. To take it back here: agency agent --core --handoff <file>"),
  );
}

function isUserMessagePause(interrupts: Interrupt[]): boolean {
  return interrupts.some((interrupt) => interrupt.effect === USER_MESSAGE);
}

function failureText(data: unknown): string {
  if (typeof data === "object" && data !== null && "error" in data) {
    return String((data as { error: unknown }).error);
  }
  return "The run ended.";
}

export async function coreAgent(args: string[]): Promise<void> {
  const coreArgs = parseCoreArgs(args);
  const handoff = coreArgs.handoff === null ? null : readHandoff(coreArgs.handoff);
  if (handoff !== null) {
    coreArgs.model = handoff.model;
    coreArgs.provider = handoff.provider;
  }
  const cwd = handoff?.cwd ?? process.cwd();
  const core = await loadCore();
  const policy = policyFor(cwd);
  const transcript: HandoffItem[] = [...(handoff?.transcript ?? [])];
  const callbacks = makeCallbacks(transcript);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => process.exit(130));

  console.log(cyan(`agency agent --core  ·  ${cwd}  ·  ${coreArgs.model}`));
  console.log(dim("/handoff hands this session to the app. /exit quits.\n"));

  let interrupts: Interrupt[];
  if (handoff !== null && coreArgs.handoff !== null) {
    console.log(dim(`Continuing a session handed over from ${handoff.from}:\n`));
    replay(handoff.transcript);
    // Workaround for ADI-320: a process that only resumes never initializes
    // the stdlib statics. Run the program once (its pause is thrown away).
    await core.main(cwd, coreArgs.model, coreArgs.provider, { callbacks: {}, policy });
    interrupts = handoff.interrupts;
    rmSync(coreArgs.handoff, { force: true });
  } else {
    const started = await core.main(cwd, coreArgs.model, coreArgs.provider, { callbacks, policy });
    if (!hasInterrupts(started.data)) {
      console.log(red(`Could not start: ${failureText(started.data)}`));
      process.exit(1);
    }
    interrupts = started.data;
  }
  let lastPause = interrupts;

  while (true) {
    let responses: InterruptResponse[];
    if (isUserMessagePause(interrupts)) {
      lastPause = interrupts;
      const line = (await rl.question(cyan("> "))).trim();
      if (line === "") continue;
      if (line === "/exit") break;
      if (line === "/handoff") {
        handOff({ interrupts, transcript, cwd, coreArgs });
        break;
      }
      transcript.push({ role: "user", text: line });
      responses = [approve(line)];
    } else {
      responses = await askApprovals(rl, interrupts);
    }
    const result = await core.respondToInterrupts(interrupts, responses, {
      callbacks,
      invocation: { policy },
    });
    if (hasInterrupts(result.data)) {
      interrupts = result.data;
    } else {
      console.log(red(`Run failed: ${failureText(result.data)}`));
      interrupts = lastPause;
    }
  }
  rl.close();
  process.exit(0);
}
