// The session core's interface, as a front-end uses it: what the agent's
// session program (`lib/agents/agency-agent/program.agency`) is started
// with, what its pause reports, and the answers the pause takes. See
// docs/dev/agents/session-core.md.
//
// This file does not import the program, so a test that runs a small
// fixture program never loads the agent.
import type { Interrupt } from "../../runtime/interrupts.js";
import { validatePolicy, type Policy } from "../../runtime/policy.js";
import { failure, success, type Result } from "../../types/result.js";
import { isPlainObject } from "../../utils/isPlainObject.js";
import { isSessionRecord, type SessionRecord } from "../agentSessions.js";

/** The effect of the pause the core waits for an answer at. */
export const SESSION_INPUT_EFFECT = "agent::sessionInput";

/** Why a session whose own policy is not a valid policy is not resumed. */
export const POLICY_UNREADABLE =
  "This session's own policy can't be read, so it can't be continued here.";

/** One turn's limits: US dollars and milliseconds. */
export type TurnBudget = { maxCost: number; maxTime: number };

/** `policy` is the policy the session's policy flags resolved to, or null
 *  (or left out) when it was started with none. The session carries it,
 *  and a front-end that resumes the session runs it under that policy
 *  (`sessionRunPolicy`). It must be a valid policy: the core does not
 *  check it, and a session whose policy is not valid can't be resumed. */
export type SessionStart = {
  cwd: string;
  replyStyle: string;
  record: SessionRecord | null;
  flags: Record<string, unknown> | null;
  budget: TurnBudget;
  policy?: Policy | null;
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
};

/** A slot's model. `provider` is the name the run uses, which for OpenAI
 *  is `openai-responses`, not the name a person sees. */
export type ResolvedModel = { model: string; provider: string; via: string };

/** What the core reports at its pause. `effort` is "" when no one named
 *  one. `fixedProvider` is "" or the provider the session is fixed to, by
 *  the name a person sees. `policy` is the session's own policy, or null
 *  when it carries none. */
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
  policy: Policy | null;
};

export type MessageAnswer = { kind: "message"; text: string; notes: string[]; target: string };

/** An answer that changes the chat's settings. Each is one of the core's:
 *  it applies it and pauses again, with no model call. `options` is
 *  `unknown` for the reason the core types it `any`: checking it against
 *  a type would fill in fields, and a null LLM option means "remove it". */
export type SettingsAnswer =
  | { kind: "model"; spec: string }
  | { kind: "options"; options: unknown }
  | { kind: "effort"; effort: string }
  | { kind: "preset"; name: string }
  | { kind: "budget"; maxCost: number; maxTime: number };

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

function isPolicy(value: unknown): value is Policy {
  return validatePolicy(value).success;
}

function pauseFields(pause: Interrupt[]): unknown {
  return pause.find((interrupt) => interrupt.effect === SESSION_INPUT_EFFECT)?.data;
}

/** The policy the session carries, from its pause: null when it carries
 *  none (it was started with no policy flag, or by a version of the core
 *  that did not report one). Fails when the policy is there but is not a
 *  valid policy. Such a session is not resumed: run under a front-end's
 *  own policy instead, it could be approved what its own policy asks
 *  about. */
export function carriedPolicy(pause: Interrupt[]): Result<Policy | null> {
  const data = pauseFields(pause);
  const policy: unknown = isPlainObject(data) ? data.policy : undefined;
  if (policy === undefined || policy === null) {
    return success(null);
  }
  return isPolicy(policy) ? success(policy) : failure(POLICY_UNREADABLE);
}

/** What the core reported at this pause, or null when the interrupts are
 *  not its pause. The data comes out of a checkpoint, so each field is
 *  checked. A pause whose policy is not valid is null too: `carriedPolicy`
 *  says why, and `restoredPhase` ends such a session. */
export function pauseData(pause: Interrupt[]): PauseData | null {
  const data = pauseFields(pause);
  if (!isPlainObject(data) || !isBudget(data.budget) || !isModels(data.models)) {
    return null;
  }
  const policy = carriedPolicy(pause);
  if (!policy.success) {
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
    policy: policy.value,
  };
}
