import { nanoid } from "nanoid";
import type { AgencyConfig } from "../config.js";
import { validatePolicy } from "./policy.js";
import type { Policy } from "./policy.js";

/**
 * Per-invocation overrides a caller may attach to a single node, served
 * function, or serve-resume invocation. This is the ONE public, declarative
 * request shape; a host (e.g. statelog) constructs it as trusted input.
 *
 * `config` is applied override-wins for that call only — agency performs no
 * clamping, bounds-checking, or trust filtering (that is host policy; see the
 * spec §2). `traceId` becomes the run's root trace id on a fresh invocation.
 */
export type InvocationOptions = {
  config?: Partial<AgencyConfig>;
  traceId?: string;
  /** Root interrupt policy for this invocation, installed as the outermost
   *  handler on the fresh run and re-installed on every resume leg. A
   *  `reject` here beats any approval from the program's own handlers
   *  (chain precedence: reject > propagate > approve). Replaces — does not
   *  merge with — an `AGENCY_RUN_POLICY` environment policy for this run. */
  policy?: Policy;
};

/**
 * A fresh run or a resume, described declaratively for {@link resolveInvocation}.
 * A fresh run may carry an inherited subprocess run id (which wins over any
 * supplied trace id) and a harness-given trace id from the environment
 * (`AGENCY_TRACE_ID`, the fallback below a supplied one); a resume carries
 * the run id read from the interrupt.
 */
export type InvocationRequest =
  | {
      kind: "fresh";
      options?: InvocationOptions;
      inheritedRunId?: string;
      /** `AGENCY_TRACE_ID`, when a harness set it for the whole process tree. */
      environmentTraceId?: string;
    }
  | { kind: "resume"; options?: InvocationOptions; runId: string };

/**
 * The subset of {@link PerInvocationContextOverride}.log that is honored
 * per-invocation. Deliberately narrower than `AgencyConfig.log`: `logFile` and
 * `debugMode` are excluded (local-only sinks, not part of this channel).
 */
export type PerInvocationLogConfig = {
  host?: string;
  apiKey?: string;
  projectId?: string;
  requestTimeoutMs?: number;
  metadata?: NonNullable<AgencyConfig["log"]>["metadata"];
};

/**
 * The positively allow-listed context override the runtime will apply. Every
 * field here is safe to override per-call. Fields absent from this type — all
 * `client.*`, `traceFile`/`traceDir`, `log.logFile`, and everything else — are
 * inert in this channel by construction: they are simply never copied across.
 */
export type PerInvocationContextOverride = {
  observability?: boolean;
  log?: PerInvocationLogConfig;
  budget?: AgencyConfig["budget"];
  maxCallDepth?: number;
  failurePropagation?: AgencyConfig["failurePropagation"];
};

/**
 * The runtime-internal result of resolving an {@link InvocationRequest}: one
 * effective run id plus an already-narrowed context override. Execution-context
 * construction consumes this directly and never re-derives the allow-list.
 */
export type ResolvedInvocation = {
  runId: string;
  contextOverride?: PerInvocationContextOverride;
  /** The validated root policy for this invocation, when the caller sent one. */
  policy?: Policy;
};

/**
 * Project a caller's raw config down to the per-invocation allow-list. Copies
 * ONLY the v1 fields, building fresh objects; it never spreads `config.log`, so
 * a future dangerous `log` sub-field cannot leak through. Returns `undefined`
 * when nothing supported was supplied, so an all-inert override adds no object.
 */
function selectContextOverride(
  config: Partial<AgencyConfig> | undefined,
): PerInvocationContextOverride | undefined {
  if (!config) {
    return undefined;
  }

  const override: PerInvocationContextOverride = {};
  let hasField = false;

  if (config.observability !== undefined) {
    override.observability = config.observability;
    hasField = true;
  }
  if (config.budget !== undefined) {
    override.budget = config.budget;
    hasField = true;
  }
  if (config.maxCallDepth !== undefined) {
    override.maxCallDepth = config.maxCallDepth;
    hasField = true;
  }
  if (config.failurePropagation !== undefined) {
    override.failurePropagation = config.failurePropagation;
    hasField = true;
  }

  const log = selectLogConfig(config.log);
  if (log !== undefined) {
    override.log = log;
    hasField = true;
  }

  return hasField ? override : undefined;
}

/**
 * Copy the five allowed `log` keys individually. `logFile` and `debugMode` are
 * intentionally omitted (local-only sinks — spec §5). Returns `undefined` when
 * no allowed key was present.
 */
function selectLogConfig(log: AgencyConfig["log"] | undefined): PerInvocationLogConfig | undefined {
  if (!log) {
    return undefined;
  }

  const selected: PerInvocationLogConfig = {};
  let hasKey = false;

  if (log.host !== undefined) {
    selected.host = log.host;
    hasKey = true;
  }
  if (log.apiKey !== undefined) {
    selected.apiKey = log.apiKey;
    hasKey = true;
  }
  if (log.projectId !== undefined) {
    selected.projectId = log.projectId;
    hasKey = true;
  }
  if (log.requestTimeoutMs !== undefined) {
    selected.requestTimeoutMs = log.requestTimeoutMs;
    hasKey = true;
  }
  if (log.metadata !== undefined) {
    selected.metadata = log.metadata;
    hasKey = true;
  }

  return hasKey ? selected : undefined;
}

/**
 * The single owner of run-id policy and per-invocation config projection.
 * Transport layers forward an {@link InvocationRequest} here and receive a
 * {@link ResolvedInvocation}; no caller re-implements trace precedence, resume
 * policy, or the config allow-list.
 *
 * Run-id precedence for a fresh run: an inherited subprocess id wins (so child
 * events land in the parent's trace), then a supplied `traceId`, then the
 * environment's `AGENCY_TRACE_ID` (a harness giving a whole process tree —
 * root included — one trace id), then a fresh `nanoid()`. A resume always
 * keeps `interrupt.runId`; a supplied `traceId` — empty or not — is ignored.
 * A supplied empty trace id on a fresh run is a caller error and is rejected.
 */
export function resolveInvocation(request: InvocationRequest): ResolvedInvocation {
  const contextOverride = selectContextOverride(request.options?.config);
  const policy = validateInvocationPolicy(request.options?.policy);

  if (request.kind === "resume") {
    return { runId: request.runId, contextOverride, policy };
  }

  const runId =
    request.inheritedRunId ??
    request.options?.traceId ??
    emptyToUndefined(request.environmentTraceId) ??
    nanoid();
  if (runId.length === 0) {
    throw new Error("traceId must not be empty");
  }
  return { runId, contextOverride, policy };
}

/**
 * Validate a caller-supplied root policy. An invalid one is a host bug, so it
 * throws — before any execution context exists. The serve adapter logs the
 * message host-side and returns its generic error to the caller. A plain
 * `Error` with a fixed prefix, matching the env channel's identical failure
 * (`loadEnvPolicy`); nothing catches this by type.
 */
function validateInvocationPolicy(policy: Policy | undefined): Policy | undefined {
  if (policy === undefined) {
    return undefined;
  }
  const valid = validatePolicy(policy);
  if (!valid.success) {
    throw new Error(`invalid invocation policy: ${valid.error}`);
  }
  return policy;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
