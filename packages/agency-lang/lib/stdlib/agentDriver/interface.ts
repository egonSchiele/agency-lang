// The session core's interface, as a front-end uses it: what the agent's
// session program (`lib/agents/agency-agent/program.agency`) is started
// with, what its pause reports, and the answers the pause takes. See
// docs/dev/agents/session-core.md.
//
// This file does not import the program, so a test that runs a small
// fixture program never loads the agent.
import type { Interrupt } from "../../runtime/interrupts.js";
import { isPlainObject } from "../../utils/isPlainObject.js";
import { isSessionRecord, type SessionRecord } from "../agentSessions.js";

/** The effect of the pause the core waits for an answer at. */
export const SESSION_INPUT_EFFECT = "agent::sessionInput";

/** One turn's limits: US dollars and milliseconds. */
export type TurnBudget = { maxCost: number; maxTime: number };

export type SessionStart = {
  cwd: string;
  replyStyle: string;
  record: SessionRecord | null;
  flags: Record<string, unknown> | null;
  budget: TurnBudget;
};

/** The startup model flags. */
export type ModelFlags = {
  pin: string;
  slots: Record<string, string>;
  provider: string;
  local: string | null;
  effort: string | null;
};

/** The startup tool limits. */
export type LimitFlags = { maxToolCallRounds: number | null; maxToolResultChars: number | null };

export type ProgramStart = {
  /** A brain's name, or "" for the user's default. */
  brain: string;
  preset: string;
  models: ModelFlags;
  limits: LimitFlags;
  session: SessionStart;
  /** The name the run's statelog groups it under, such as
   *  "agency-agent/coordinator". Left out or "", none is set. */
  agentName?: string;
  /** A run that takes one message and ends, as `agency agent -p`. It gets
   *  more tool rounds by default. Left out, the session goes on. */
  oneShot?: boolean;
};

/** A slot's model. `provider` is the name the run uses, which for OpenAI
 *  is `openai-responses`, not the name a person sees. */
export type ResolvedModel = { model: string; provider: string; via: string };

/** What the core reports at its pause. `effort` is "" when no one named
 *  one. `fixedProvider` is "" or the provider the session is fixed to, by
 *  the name a person sees. `search` is the web search backend in force:
 *  "hosted", "tavily", "brave" or "off" ("" from a core that did not
 *  report one). */
export type PauseData = {
  thread: string;
  cwd: string;
  record: SessionRecord | null;
  models: Record<string, ResolvedModel>;
  preset: string;
  fixedProvider: string;
  effort: string;
  budget: TurnBudget;
  context: string;
  brain: string;
  search: string;
};

export type MessageAnswer = { kind: "message"; text: string; notes: string[]; target: string };

/** An answer that changes the session and is not a turn. The core applies
 *  it and pauses again. Only `compact` calls a model, for the summary.
 *  One the core refuses changes nothing, and it says why in an error
 *  notice. `options` is `unknown` for the reason the core types it `any`:
 *  checking it against a type would fill in fields, and a null LLM option
 *  means "remove it".
 *
 *  - `compact`: summarize the older messages now. `keep` says what the
 *    summary must keep, or "".
 *  - `rename`: the session's new title.
 *  - `fork`: from here on the session is a copy with a new `record.id`,
 *    and `record.forkedFrom` names the original. The front-end uses the
 *    new id for every later save, `stillHeld` and `takeHold`, and keys
 *    the session by it.
 *  - `search`: switch the web search backend, and save it to settings.json.
 *  - `savePreset`: save the session's models and options to a preset, ""
 *    for the active one. */
export type SettingsAnswer =
  | { kind: "model"; spec: string }
  | { kind: "options"; options: unknown }
  | { kind: "effort"; effort: string }
  | { kind: "preset"; name: string }
  | { kind: "budget"; maxCost: number; maxTime: number }
  | { kind: "compact"; keep: string }
  | { kind: "rename"; title: string }
  | { kind: "fork" }
  | { kind: "search"; backend: string }
  | { kind: "savePreset"; name: string };

export type Answer = MessageAnswer | SettingsAnswer;

/** A message for the main agent. A bare string is not an answer. */
export function messageAnswer(text: string): MessageAnswer {
  return { kind: "message", text, notes: [], target: "" };
}

function isBudget(value: unknown): value is TurnBudget {
  return (
    isPlainObject(value) && typeof value.maxCost === "number" && typeof value.maxTime === "number"
  );
}

function isResolvedModel(value: unknown): value is ResolvedModel {
  return (
    isPlainObject(value) && typeof value.model === "string" && typeof value.provider === "string"
  );
}

function isModels(value: unknown): value is Record<string, ResolvedModel> {
  return isPlainObject(value) && Object.values(value).every(isResolvedModel);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** What the core reported at this pause, or null when the interrupts are
 *  not its pause. The data comes out of a checkpoint, so each field is
 *  checked. */
export function pauseData(pause: Interrupt[]): PauseData | null {
  const waiting = pause.find((interrupt) => interrupt.effect === SESSION_INPUT_EFFECT);
  const data: unknown = waiting?.data;
  if (!isPlainObject(data) || !isBudget(data.budget) || !isModels(data.models)) {
    return null;
  }
  return {
    thread: text(data.thread),
    cwd: text(data.cwd),
    record: isSessionRecord(data.record) ? data.record : null,
    models: data.models,
    preset: text(data.preset),
    fixedProvider: text(data.fixedProvider),
    effort: text(data.effort),
    budget: data.budget,
    context: text(data.context),
    brain: text(data.brain),
    search: text(data.search),
  };
}
