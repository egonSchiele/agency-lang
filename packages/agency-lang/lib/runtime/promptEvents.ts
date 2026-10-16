/**
 * The two statelog events a prompt writes, and the redaction every logged
 * message goes through. `_runPrompt` in prompt.ts calls these; they live
 * here so prompt.ts holds the tool loop and not the log format.
 */
import * as smoltalk from "smoltalk";
import type { PromptResult, UserContentInput } from "smoltalk";
import { redactAttachments } from "smoltalk";
import type { Run } from "./asyncContext.js";
import type { ProviderUsageKind } from "./invocationUsage.js";
import type { MessageThread } from "./state/messageThread.js";
import type { Tool } from "./prompt.js";
import type { DecisionLog } from "../statelog/wireTypes.js";

/** Deep copy of a thread's messages with attachment payloads (base64 / data
 *  URIs) redacted, for statelog. Uses `toJSON()` — the same plain shape
 *  `JSON.stringify` would emit — so wire consumers like
 *  `wireAccessors.userMessageOf` keep working. Redaction only shortens base64
 *  string values, so the result is still structurally `MessageJSON[]`. */
export function redactMessagesForLog(messages: MessageThread): smoltalk.MessageJSON[] {
  return redactAttachments(messages.toJSON().messages) as smoltalk.MessageJSON[];
}

/** A thread's redacted messages for statelog, each carrying its debug
 *  label (from `llm(label:)` / `userMessage(msg, label:)`) when it has
 *  one. Reads the labels off the SAME thread that produced the dump, so
 *  index `i` lines up: `redactMessagesForLog` maps `messages` in order,
 *  and smoltalk's `redactAttachments` is 1:1 over an array. That second
 *  half is someone else's implementation detail, so a test pins the
 *  pairing through the redaction path with a real attachment.
 *
 *  Unlabeled messages are emitted unchanged rather than with `label:
 *  null`, so logs for label-free programs stay byte-identical. */
export function withMessageLabels(
  messages: MessageThread,
): (smoltalk.MessageJSON & { label?: string })[] {
  return redactMessagesForLog(messages).map((m, i) => {
    const label = messages.labelAt(i);
    return label === null ? m : { ...m, label };
  });
}

/** A prompt with attachment payloads redacted, preserving its string-or-array
 *  shape, for statelog / hook data. */
export function redactPromptForLog(p: string | UserContentInput): string | UserContentInput {
  return redactAttachments(p) as string | UserContentInput;
}

export function emitPromptStart({
  run,
  messages,
  tools,
  responseFormat,
  clientConfig,
  callLabel,
  usageKind,
}: {
  run: Run;
  messages: MessageThread;
  tools: Tool[];
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolConfig>;
  /** This call's `llm(label:)` debug tag, or null. Observability only. */
  callLabel?: string | null;
  usageKind: ProviderUsageKind;
}): void {
  run.log.promptStart({
    model: JSON.stringify(clientConfig.model),
    threadId: run.threads.activeId() ?? null,
    messageCount: messages.getMessages().length,
    toolCount: tools.length,
    hasResponseFormat: responseFormat != null,
    maxTokens: clientConfig.maxTokens ?? null,
    label: callLabel ?? null,
    usageKind,
  });
}

/** The `promptCompletion` event: the redacted thread with its labels, the
 *  completion, the usage and cost, and for a decision model what it was
 *  sent and what it answered. */
export function emitPromptCompletion({
  run,
  messages,
  completion,
  projectedUsage,
  modelName,
  timeTaken,
  tools,
  responseFormat,
  stream,
  usageKind,
  decision,
}: {
  run: Run;
  messages: MessageThread;
  completion: PromptResult;
  projectedUsage: PromptResult["usage"];
  modelName: unknown;
  timeTaken: number;
  tools: Tool[];
  responseFormat?: any;
  stream: boolean;
  usageKind: ProviderUsageKind;
  decision?: DecisionLog;
}): void {
  run.log.promptCompletion({
    messages: withMessageLabels(messages),
    // Sanitize the nested usage too — the top-level `usage` alone isn't enough,
    // the echoed completion carries its own raw `usage` (see projectProviderTokenUsage).
    // A decision call's rawData is its answers, which `decision` carries
    // explicitly, so the echo leaves it out rather than logging them twice.
    completion: {
      ...completion,
      usage: projectedUsage,
      ...(decision === undefined ? {} : { rawData: undefined }),
    },
    model: JSON.stringify(modelName),
    timeTaken,
    tools,
    responseFormat,
    usage: projectedUsage,
    cost: completion.cost,
    // Statelog's field name; smoltalk's is `stopReason`.
    finishReason: completion.stopReason ?? completion.rawStopReason,
    stream,
    threadId: run.threads.activeId() ?? null,
    threadIdentity: messages.id,
    threadLabel: messages.label,
    usageKind,
    decision,
  });
}
