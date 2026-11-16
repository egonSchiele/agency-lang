// SPIKE: the file one front-end writes to hand a paused agent session to
// another. It is plain JSON, so a front-end in any language can read it.
// Perry's engine reads and writes the same shape (perry src/engine/handoff.ts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { Interrupt } from "@/runtime/index.js";

/** What a person saw, so the next front-end can show the history. */
export type HandoffItem = {
  role: "user" | "assistant" | "tool" | "notice" | "error";
  text: string;
};

export type HandoffFile = {
  version: 1;
  /** The core the session runs in. A front-end must import this module, from
   *  the same agency-lang build, to resume the interrupts. */
  core: "std::agents/session";
  cwd: string;
  model: string;
  provider: string;
  /** Where it came from, for display: "terminal", "perry", ... */
  from: string;
  createdAt: string;
  /** The paused session: the interrupts, each with its checkpoint. */
  interrupts: Interrupt[];
  transcript: HandoffItem[];
};

export const SESSION_CORE = "std::agents/session";

export function handoffDir(): string {
  return process.env.AGENCY_HANDOFF_DIR ?? path.join(homedir(), ".agency", "handoffs");
}

/** Writes the file (only you can read it: it holds the whole run) and
 *  returns its path. */
export function writeHandoff(handoff: HandoffFile): string {
  const dir = handoffDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(handoff), { mode: 0o600 });
  return file;
}

export function readHandoff(file: string): HandoffFile {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (
    parsed?.version !== 1 ||
    parsed?.core !== SESSION_CORE ||
    !Array.isArray(parsed?.interrupts)
  ) {
    throw new Error(`${file} is not an agent session handoff`);
  }
  return parsed as HandoffFile;
}
