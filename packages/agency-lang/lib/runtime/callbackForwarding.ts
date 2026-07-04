/**
 * Fire-and-forget forwarding of lifecycle callbacks from a subprocess to its
 * parent, so a parent's registered AgencyCallbacks fire for events that happen
 * inside a std::agency run() child (see
 * docs/superpowers/specs/2026-07-02-subprocess-callback-forwarding-design.md).
 *
 * Dependency-light leaf (mirrors costTelemetry.ts): the only runtime import is
 * subprocessRunInfo.ts (for isIpcMode + the shared ipcChildDebug). invokeCallbacks
 * (hooks.ts) calls sendCallbackToParent on every event; hooks.ts must not import
 * ipc.ts, so the wire type + sender live here.
 *
 * Never blocks, never throws, and never kills the run: no reply, no listener; a
 * dead channel or an over-limit / unserializable payload is swallowed — the
 * event is observational, so dropping it is always safe.
 *
 * Forwarding is UNCONDITIONAL: the child cannot know which callbacks the parent
 * registered, so every event (except the NON_FORWARDABLE_CALLBACKS denylist) is
 * serialized and sent on every occurrence, even when no parent callback exists.
 * Payloads can be large (full messages arrays, run results). Accepted v1
 * tradeoff — see the plan's "Scope & design tradeoffs".
 */

import { isIpcMode, ipcChildDebug } from "./subprocessRunInfo.js";
import type { CallbackName } from "../types/function.js";

export type IpcCallbackMessage = {
  type: "callback";
  name: CallbackName;
  // JSON-sanitized payload; function fields (e.g. onAgentStart.cancel) dropped.
  data: any;
};

/** Skip threshold for a forwarded callback payload. Matches the default
 * ipcPayload limit (ipc.ts DEFAULT_LIMITS) so the child's skip and the parent's
 * drop agree. Purely defensive: real callback payloads are KB-MB, far under it. */
export const CALLBACK_PAYLOAD_LIMIT = 1024 * 1024 * 1024; // 1gb

/** Callbacks that MUST NOT be forwarded. onStream and onOAuthRequired carry
 * function / Promise fields (cancel, complete) whose semantics require a live
 * local channel; JSON forwarding would strip them and fire a broken callback in
 * the parent. Neither currently reaches this function (onStream dispatches
 * outside invokeCallbacks; onOAuthRequired is never fired), so this is a
 * defensive guard against a future refactor routing them through the choke
 * point. onTrace is function-free and simply never fires today, so it is
 * excluded by non-existence rather than listed here. See the plan's
 * "Scope & design tradeoffs" section. */
const NON_FORWARDABLE_CALLBACKS: readonly CallbackName[] = ["onStream", "onOAuthRequired"];

/** Forward one lifecycle event to the parent. No-op unless this process is a
 * forked Agency subprocess with a live IPC channel. `maxBytes` is overridable
 * only so tests can exercise the oversize-skip without a gigabyte payload. */
export function sendCallbackToParent(
  name: CallbackName,
  data: unknown,
  maxBytes: number = CALLBACK_PAYLOAD_LIMIT,
): void {
  if (!isIpcMode() || typeof process.send !== "function") return;
  if (NON_FORWARDABLE_CALLBACKS.includes(name)) return; // functions/Promises can't survive JSON
  // JSON.stringify drops function-valued fields (e.g. onAgentStart.cancel) and
  // throws on circular refs / BigInt. Serialize ONCE up front so an
  // un-serializable payload degrades to a dropped event instead of a throw
  // inside process.send, and so what we measure equals what we send.
  let serialized: string;
  try {
    serialized = JSON.stringify({ type: "callback", name, data });
  } catch (err) {
    ipcChildDebug(`callback_unserializable ${name} ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    ipcChildDebug(`callback_dropped_oversize ${name}`);
    return;
  }
  try {
    // Re-parse so the sent object is guaranteed function-free regardless of the
    // channel's serialization mode.
    process.send(JSON.parse(serialized) as IpcCallbackMessage);
  } catch (err) {
    // Channel gone — parent died; the watchdog will reap this process.
    ipcChildDebug(`callback_send_failed ${name} ${err instanceof Error ? err.message : String(err)}`);
  }
}
