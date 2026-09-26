/**
 * Batches the decision calls of one fork or parallel block. Each arm hands
 * its call to the collector and waits. When no arm is still running, or a
 * group reaches the model's question cap, the collector sends every group
 * at once and gives each call its own slice of the answers, usage, and
 * cost. See docs/dev/llm/decision-models.md, "Batching inside parallel".
 */
import { createHash } from "crypto";
import { success, type CostEstimate, type Result } from "smoltalk";
import type {
  DecideConfig,
  DecideResult,
  DecisionAnswer,
  DecisionQuestion,
  DecisionState,
} from "./llmClient.js";

/** The cap used for a model the registry does not know. Jev's own. */
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

export type DecisionBatchReport = {
  reason: "quiescent" | "cap";
  groups: BatchGroupReport[];
};

export type CollectorHooks = {
  /** A round is about to be sent. Returns the callback to run once every
   *  group in it has answered. */
  batchStarted: (report: DecisionBatchReport) => () => void;
  /** A group reached the model's cap and was sent early. */
  capReached: (model: string, cap: number) => void;
};

/** What an arm's frame carries: the block's collector and the arm's key. */
export type DecisionScope = { collector: DecisionCollector; armKey: string };

// running: body executing between decision calls (the only status that blocks
//   a quiescent round). waiting: holds a pending call not yet sent. inflight:
//   its call was sent and awaits a response. settled: its branch is done.
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

/** Split `total` in proportion to `weights`, integer parts, remainder to the first. */
export function splitCounts(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  const parts = weights.map((weight) => Math.floor((total * weight) / sum));
  const given = parts.reduce((acc, part) => acc + part, 0);
  parts[0] += total - given;
  return parts;
}

function groupKeyFor(request: DecisionRequest): string {
  const identity = {
    model: request.config.model,
    baseUrl: request.config.baseUrl,
    state: request.state,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export class DecisionCollector {
  private arms: Record<string, ArmStatus> = {};
  private pending: PendingCall[] = [];
  private nextId = 1;

  constructor(
    armKeys: string[],
    private readonly send: DecisionSender,
    private readonly hooks: CollectorHooks,
  ) {
    for (const key of armKeys) {
      this.arms[key] = "running";
    }
  }

  armSettled(armKey: string): void {
    this.arms[armKey] = "settled";
    this.fireIfQuiescent();
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
          // The call was never sent, so this arm no longer owes the round
          // anything. Mark it settled so it stops blocking quiescence; if its
          // body resumes and asks again, submit revives it to waiting.
          this.pending = this.pending.filter((other) => other !== call);
          this.arms[armKey] = "settled";
          reject(request.signal.reason);
          this.fireIfQuiescent();
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
      this.arms[armKey] = "waiting";

      const group = this.groupOf(call.groupKey)!;
      if (group.questionCount >= request.questionCap) {
        this.hooks.capReached(request.config.model, request.questionCap);
        this.fire([group], "cap");
        return;
      }
      this.fireIfQuiescent();
    });
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

  private fireIfQuiescent(): void {
    if (this.pending.length === 0) {
      return;
    }
    const running = Object.values(this.arms).some((status) => status === "running");
    if (running) {
      return;
    }
    this.fire(this.groups(), "quiescent");
  }

  private fire(groups: Group[], reason: DecisionBatchReport["reason"]): void {
    const firing = groups.flatMap((group) => group.calls);
    this.pending = this.pending.filter((call) => !firing.includes(call));
    for (const call of firing) {
      call.request.signal.removeEventListener("abort", call.onAbort);
      // The call is on the wire now, not blocking siblings, but not yet
      // resumable either. Its arm becomes running again when the answer lands.
      this.arms[call.armKey] = "inflight";
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
    const ended = this.hooks.batchStarted(report);
    void Promise.all(groups.map((group) => this.sendGroup(group))).finally(ended);
  }

  private async sendGroup(group: Group): Promise<void> {
    const merged: Record<string, DecisionQuestion> = {};
    for (const call of group.calls) {
      for (const name of Object.keys(call.request.questions)) {
        merged[questionKey(call.id, name)] = call.request.questions[name];
      }
    }

    // One request for the group. It is cancelled only when every call in it
    // has aborted; a single aborted call just loses its answers.
    const controller = new AbortController();
    const live: PendingCall[] = [...group.calls];
    for (const call of group.calls) {
      call.request.signal.addEventListener(
        "abort",
        () => {
          live.splice(live.indexOf(call), 1);
          call.reject(call.request.signal.reason);
          if (live.length === 0) {
            controller.abort(call.request.signal.reason);
          }
        },
        { once: true },
      );
    }

    const first = group.calls[0].request;
    const result = await this.send(first.state, merged, first.config, controller.signal);
    if (!result.success) {
      for (const call of live) {
        // The arm's body resumes to run its own retry loop.
        this.arms[call.armKey] = "running";
        call.resolve(result);
      }
      return;
    }

    const weights = group.calls.map((call) => call.questionCount);
    const inputTokens = splitCounts(result.value.usage.inputTokens, weights);
    const outputTokens = splitCounts(result.value.usage.outputTokens, weights);
    group.calls.forEach((call, index) => {
      if (!live.includes(call)) {
        return;
      }
      // The answer is in; the arm's body resumes.
      this.arms[call.armKey] = "running";
      const share = call.questionCount / group.questionCount;
      const cost =
        result.value.cost === undefined ? undefined : scaleCost(result.value.cost, share);
      call.resolve(
        success({
          answers: answersFor(call.id, result.value.answers),
          usage: { inputTokens: inputTokens[index], outputTokens: outputTokens[index] },
          cost,
          model: result.value.model,
        }),
      );
    });
  }
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
    const match = QUESTION_KEY.exec(key);
    if (match !== null && Number(match[1]) === callId) {
      answers[match[2]] = merged[key];
    }
  }
  return answers;
}
