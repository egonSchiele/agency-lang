import type { CASResult } from "./contentAddressableStore.js";
import type { Checkpoint } from "../state/checkpointStore.js";

export type CheckpointJSON = ReturnType<Checkpoint["toJSON"]>;

export const CHECKPOINT_SCHEMA = {
  stack: { stack: true },
  globals: { store: true },
} as const;

export type TraceHeader = {
  type: "header";
  version: number;
  agencyVersion: string;
  program: string;
  timestamp: string;
  config: { hashAlgorithm: string };
  bundle?: boolean;
  runId: string;
};

export type TraceSource = {
  type: "source";
  path: string;
  content: string;
};

export type TraceChunk = {
  type: "chunk";
  hash: string;
  data: any;
};

export type TraceManifest = {
  type: "manifest";
} & CASResult<CheckpointJSON, typeof CHECKPOINT_SCHEMA>;

export type TraceFooter = {
  type: "footer";
  checkpointCount: number;
  chunkCount: number;
  timestamp: string;
};

export type TraceStaticState = {
  type: "static-state";
  values: Record<string, unknown>;
};

export type TraceLine =
  | TraceHeader
  | TraceStaticState
  | TraceSource
  | TraceChunk
  | TraceManifest
  | TraceFooter;

export type TraceEvent = {
  runId: string;
  line: TraceLine;
};

export type TraceCallback = (event: {
  runId: string;
  line: TraceLine;
}) => void | Promise<void>;

export type TraceConfig = {
  program?: string;
  /**
   * Directory for trace output. When set, each run writes to
   * `${traceDir}/${runId}.agencytrace`. Different runs (different
   * runIds) get different files automatically — safe with concurrent
   * runs of the same agent. Recommended for production.
   */
  traceDir?: string;
  /**
   * Fixed trace file path. All runs of this module write to this same
   * file. Useful for tests and single-run inspection. NOT safe with
   * concurrent runs of the same agent — they will interleave into one
   * file and `runNode` will truncate at each new run start. Prefer
   * `traceDir` for production agents that may run concurrently.
   *
   * Within a single run, multiple per-execCtx writers (one per
   * `respondToInterrupts`) cooperate via the file itself: each new
   * writer scans the on-disk trace at construction (see
   * `scanExistingTraceFile` in `traceWriter.ts`) to skip writing a
   * duplicate header and to seed its CAS so chunks already on disk are
   * not re-emitted.
   *
   * If both `traceFile` and `traceDir` are set, `traceFile` wins.
   */
  traceFile?: string;
  traceCallback?: TraceCallback;
};
