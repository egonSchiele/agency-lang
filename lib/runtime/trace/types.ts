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

export type TraceLine =
  | TraceHeader
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
  traceDir?: string;
  traceFile?: string;
  traceCallback?: TraceCallback;
};
