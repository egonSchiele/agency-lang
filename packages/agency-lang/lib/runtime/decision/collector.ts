/**
 * Batches the decision calls of one fork or parallel block. Each arm hands
 * its call to the collector and waits. When the block is idle, meaning no
 * arm is still running, or when a group reaches the model's question cap,
 * the collector sends every group at once and gives each call its own
 * slice of the answers, usage, and cost. See
 * docs/dev/llm/decision-models.md, "Batching inside parallel".
 */
import { createHash } from "crypto";
import { failure, success, type CostEstimate, type Result } from "smoltalk";
import type {
  DecideConfig,
  DecideResult,
  DecisionAnswer,
  DecisionQuestion,
  DecisionState,
} from "../llmClient.js";

/** The cap used for a model the registry does not know. */
export const DEFAULT_QUESTION_CAP = 64;

export type DecisionRequest = {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  config: DecideConfig;
  /** The most questions one request to this model may carry. */
  questionCap: number;
  signal: AbortSignal;
};

export type DecisionSender = (
  state: DecisionState,
  questions: Record<string, DecisionQuestion>,
  config: DecideConfig,
  signal: AbortSignal,
) => Promise<Result<DecideResult>>;

export type BatchGroupReport = {
  model: string;
  armKeys: string[];
  callCount: number;
  questionCount: number;
};

/** Why a round was sent: the block went idle, or a group reached the cap. */
export type BatchReason = "idle" | "cap";

export type DecisionBatchReport = {
  reason: BatchReason;
  groups: BatchGroupReport[];
};

export type CollectorHooks = {
  /** Runs one round. `work` sends every group and resolves when all have
   *  answered; the hook wraps it, so a span opened before `work` and closed
   *  after it encloses the whole round. */
  runRound: (report: DecisionBatchReport, work: () => Promise<void>) => Promise<void>;
  /** A group reached the model's cap and was sent early. */
  capReached: (model: string, cap: number) => void;
};

/** What an arm's frame carries: the block's collector and the arm's key. */
export type DecisionScope = { collector: DecisionCollector; armKey: string };

/** An arm is `running` while its body executes between decision calls.
 *  Only a running arm holds up a round. `waiting` means it has a call the
 *  collector has not sent; `inflight` means its calls are all on the wire;
 *  `settled` means its branch is done. */
type ArmStatus = "running" | "waiting" | "inflight" | "settled";

type PendingCall = {
  id: number;
  armKey: string;
  groupKey: string;
  request: DecisionRequest;
  questionCount: number;
  resolve: (result: Result<DecideResult>) => void;
  reject: (reason: unknown) => void;
  /** Removes the call and rejects it; installed while the call waits. */
  onAbort: () => void;
};

type Group = { key: string; calls: PendingCall[]; questionCount: number };

/** The name a call's question travels under in a merged request. */
export function questionKey(callId: number, name: string): string {
  return `c${callId}_${name}`;
}

const QUESTION_KEY = /^c(\d+)_(.*)$/s;

/** The call id a merged question name carries, or undefined for a plain name. */
export function questionCallId(name: string): number | undefined {
  const match = QUESTION_KEY.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/** A merged question name without its call prefix. */
export function unprefixedQuestionName(name: string): string {
  const match = QUESTION_KEY.exec(name);
  return match === null ? name : match[2];
}

/** Split `total` in proportion to `weights`, integer parts, remainder to the first. */
export function splitCounts(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  const parts = weights.map((weight) => Math.floor((total * weight) / sum));
  const given = parts.reduce((acc, part) => acc + part, 0);
  parts[0] += total - given;
  return parts;
}

/** Calls share a request when they share a model, an endpoint, and a
 *  state. The rest of a `DecideConfig` (keys, model data) comes from the
 *  run's config, never from one call, so it cannot differ between arms. */
function groupKeyFor(request: DecisionRequest): string {
  const identity = {
    model: request.config.model,
    baseUrl: request.config.baseUrl,
    state: request.state,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export class DecisionCollector {
  private settledArms: Record<string, true> = {};
  private armKeys: string[];
  private pending: PendingCall[] = [];
  private inflight: PendingCall[] = [];
  private nextId = 1;

  constructor(
    armKeys: string[],
    private readonly send: DecisionSender,
    private readonly hooks: CollectorHooks,
  ) {
    this.armKeys = [...armKeys];
  }

  armSettled(armKey: string): void {
    this.settledArms[armKey] = true;
    this.fireIfIdle();
  }

  submit(armKey: string, request: DecisionRequest): Promise<Result<DecideResult>> {
    if (request.signal.aborted) {
      return Promise.reject(request.signal.reason);
    }
    return new Promise((resolve, reject) => {
      const call: PendingCall = {
        id: this.nextId++,
        armKey,
        groupKey: groupKeyFor(request),
        request,
        questionCount: Object.keys(request.questions).length,
        resolve,
        reject,
        onAbort: () => {
          this.pending = this.pending.filter((other) => other !== call);
          reject(request.signal.reason);
          this.fireIfIdle();
        },
      };
      request.signal.addEventListener("abort", call.onAbort, { once: true });

      const existing = this.groupOf(call.groupKey);
      if (
        existing !== undefined &&
        existing.questionCount + call.questionCount > request.questionCap
      ) {
        this.hooks.capReached(request.config.model, request.questionCap);
        this.fire([existing], "cap");
      }
      this.pending.push(call);

      const group = this.groupOf(call.groupKey)!;
      if (group.questionCount >= request.questionCap) {
        this.hooks.capReached(request.config.model, request.questionCap);
        this.fire([group], "cap");
        return;
      }
      this.fireIfIdle();
    });
  }

  /** An arm's status follows its calls, so no delivery can leave an arm
   *  marked running while a second call of its still waits. */
  private statusOf(armKey: string): ArmStatus {
    if (this.settledArms[armKey] === true) {
      return "settled";
    }
    if (this.pending.some((call) => call.armKey === armKey)) {
      return "waiting";
    }
    if (this.inflight.some((call) => call.armKey === armKey)) {
      return "inflight";
    }
    return "running";
  }

  private groups(): Group[] {
    const byKey: Record<string, Group> = {};
    for (const call of this.pending) {
      const group = byKey[call.groupKey] ?? { key: call.groupKey, calls: [], questionCount: 0 };
      group.calls.push(call);
      group.questionCount += call.questionCount;
      byKey[call.groupKey] = group;
    }
    return Object.values(byKey);
  }

  private groupOf(key: string): Group | undefined {
    return this.groups().find((group) => group.key === key);
  }

  private fireIfIdle(): void {
    if (this.pending.length === 0) {
      return;
    }
    const running = this.armKeys.some((armKey) => this.statusOf(armKey) === "running");
    if (running) {
      return;
    }
    this.fire(this.groups(), "idle");
  }

  private fire(groups: Group[], reason: BatchReason): void {
    const firing = groups.flatMap((group) => group.calls);
    this.pending = this.pending.filter((call) => !firing.includes(call));
    this.inflight.push(...firing);
    for (const call of firing) {
      call.request.signal.removeEventListener("abort", call.onAbort);
    }
    const report: DecisionBatchReport = {
      reason,
      groups: groups.map((group) => ({
        model: group.calls[0].request.config.model,
        armKeys: group.calls.map((call) => call.armKey),
        callCount: group.calls.length,
        questionCount: group.questionCount,
      })),
    };
    void this.hooks.runRound(report, async () => {
      await Promise.all(groups.map((group) => this.sendGroup(group)));
    });
  }

  /** Send one group's merged request and deliver each call its share.
   *  Every exit, including a throw anywhere in here, resolves or rejects
   *  every call in the group, so no arm is ever left waiting. */
  private async sendGroup(group: Group): Promise<void> {
    const live: PendingCall[] = [...group.calls];
    const controller = new AbortController();
    const abortListeners = group.calls.map((call) => {
      const listener = () => {
        live.splice(live.indexOf(call), 1);
        call.reject(call.request.signal.reason);
        if (live.length === 0) {
          controller.abort(call.request.signal.reason);
        }
      };
      call.request.signal.addEventListener("abort", listener, { once: true });
      return listener;
    });

    try {
      const result = await this.send(
        group.calls[0].request.state,
        mergedQuestions(group),
        group.calls[0].request.config,
        controller.signal,
      );
      if (result.success) {
        deliverAnswers(group, live, result.value);
      } else {
        for (const call of live) {
          call.resolve(result);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const call of live) {
        call.resolve(failure(message));
      }
    } finally {
      group.calls.forEach((call, index) => {
        call.request.signal.removeEventListener("abort", abortListeners[index]);
      });
      this.inflight = this.inflight.filter((call) => !group.calls.includes(call));
      // A delivered arm may already hold its next call. If nothing else is
      // running, that call is the next round.
      this.fireIfIdle();
    }
  }
}

function mergedQuestions(group: Group): Record<string, DecisionQuestion> {
  const merged: Record<string, DecisionQuestion> = {};
  for (const call of group.calls) {
    for (const name of Object.keys(call.request.questions)) {
      merged[questionKey(call.id, name)] = call.request.questions[name];
    }
  }
  return merged;
}

/** Give each live call its answers and its share of the tokens and cost. */
function deliverAnswers(group: Group, live: PendingCall[], result: DecideResult): void {
  const weights = group.calls.map((call) => call.questionCount);
  const inputTokens = splitCounts(result.usage.inputTokens, weights);
  const outputTokens = splitCounts(result.usage.outputTokens, weights);
  group.calls.forEach((call, index) => {
    if (!live.includes(call)) {
      return;
    }
    const share = call.questionCount / group.questionCount;
    const cost = result.cost === undefined ? undefined : scaleCost(result.cost, share);
    call.resolve(
      success({
        answers: answersFor(call.id, result.answers),
        usage: { inputTokens: inputTokens[index], outputTokens: outputTokens[index] },
        cost,
        model: result.model,
      }),
    );
  });
}

/** A cost estimate scaled to one call's share. Every numeric field is a
 *  cost (input, output, cached, hosted tools, total); `currency` is not. */
function scaleCost(cost: CostEstimate, share: number): CostEstimate {
  const scaled: Record<string, number | string> = {};
  for (const [field, value] of Object.entries(cost)) {
    scaled[field] = typeof value === "number" ? value * share : value;
  }
  return scaled as CostEstimate;
}

/** The answers that belong to one call, under their original names. */
function answersFor(
  callId: number,
  merged: Record<string, DecisionAnswer>,
): Record<string, DecisionAnswer> {
  const answers: Record<string, DecisionAnswer> = {};
  for (const key of Object.keys(merged)) {
    if (questionCallId(key) === callId) {
      answers[unprefixedQuestionName(key)] = merged[key];
    }
  }
  return answers;
}
