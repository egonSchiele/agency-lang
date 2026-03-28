import type { TokenUsage } from "smoltalk";

type AuditBase = { timestamp: number };

export type AssignmentAudit = AuditBase & {
  type: "assignment";
  variable: string;
  value: unknown;
};

export type FunctionCallAudit = AuditBase & {
  type: "functionCall";
  functionName: string;
  args: unknown;
  result: unknown;
};

export type ReturnAudit = AuditBase & {
  type: "return";
  value: unknown;
};

export type LLMCallAudit = AuditBase & {
  type: "llmCall";
  model: string;
  prompt: string;
  response: unknown;
  tokens: TokenUsage | undefined;
  duration: number;
};

export type ToolCallAudit = AuditBase & {
  type: "toolCall";
  functionName: string;
  args: unknown;
  result: unknown;
  duration: number;
};

export type NodeEntryAudit = AuditBase & {
  type: "nodeEntry";
  nodeName: string;
};

export type NodeExitAudit = AuditBase & {
  type: "nodeExit";
  nodeName: string;
};

export type InterruptAudit = AuditBase & {
  type: "interrupt";
  nodeName: string;
  args: unknown;
};

export type RestoreAudit = AuditBase & {
  type: "restore";
  checkpointId: number;
  nodeName: string;
};

export type HandlerResultAudit = AuditBase & {
  type: "handlerResult";
  handlerIndex: number;
  data: unknown;
  result: "approved" | "rejected" | "passthrough";
  value?: unknown;
};

export type HandlerDecisionAudit = AuditBase & {
  type: "handlerDecision";
  data: unknown;
  decision: "approved" | "rejected" | "unhandled";
  value?: unknown;
};

export type RewindAudit = AuditBase & {
  type: "rewind";
  nodeName: string;
  step: number;
  overrides: Record<string, unknown>;
};

export type OverrideAudit = AuditBase & {
  type: "override";
  overrides: Record<string, unknown>;
  source: "interrupt" | "rewind";
};

export type AuditEntry =
  | AssignmentAudit
  | FunctionCallAudit
  | ReturnAudit
  | LLMCallAudit
  | ToolCallAudit
  | NodeEntryAudit
  | NodeExitAudit
  | InterruptAudit
  | RestoreAudit
  | HandlerResultAudit
  | HandlerDecisionAudit
  | RewindAudit
  | OverrideAudit;

// Distributive Omit so that discriminated union members are preserved
export type AuditEntryInput = AuditEntry extends infer T
  ? T extends AuditEntry
    ? Omit<T, "timestamp">
    : never
  : never;
