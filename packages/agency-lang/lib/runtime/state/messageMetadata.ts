import * as smoltalk from "smoltalk";

/**
 * What Agency keeps in a smoltalk message's `metadata`: a debug label, and
 * when the runtime removes the message. This module is the only place that
 * spells the key names. See docs/dev/runtime/expiring-messages.md.
 */

/** Who owns an expiring message: the `llm()` call, the single model
 *  request, or the handoff dispatch that added it. */
export type ExpiresAt = "llmCall" | "request" | "handoff";

/** When the message is removed. `key` names the owner; it is null only for
 *  an `llmCall` message that Agency code pushed before the call started,
 *  which the next `llm()` call on the thread claims. */
export type Expiry = { at: ExpiresAt; key: string | null };

export type MessageMetadata = { label?: string; expires?: Expiry };

/** A change to a message's metadata: a key left out is kept, and a null
 *  value removes the key. */
export type MetadataPatch = { label?: string | null; expires?: Expiry | null };

const EXPIRES_AT: ExpiresAt[] = ["llmCall", "request", "handoff"];

function metadataOf(message: smoltalk.Message): Record<string, unknown> {
  return message.metadata ?? {};
}

/** The debug label, or null. */
export function labelOf(message: smoltalk.Message): string | null {
  const label = metadataOf(message).label;
  return typeof label === "string" ? label : null;
}

/** True when the role may carry an expiry: system or user. A tool message
 *  must stay paired with the assistant message that called it, and an
 *  assistant message with tool calls must keep its results. */
export function mayExpire(message: smoltalk.Message): boolean {
  return message.role === "system" || message.role === "user";
}

/** The expiry, or null for a message that stays with the thread. Null for a
 *  role that may not expire, whatever its JSON carries: a seeded message or
 *  an edited checkpoint can put anything there. */
export function expiryOf(message: smoltalk.Message): Expiry | null {
  if (!mayExpire(message)) {
    return null;
  }
  const expires = metadataOf(message).expires as Partial<Expiry> | undefined;
  if (typeof expires !== "object" || expires === null) {
    return null;
  }
  if (!EXPIRES_AT.includes(expires.at as ExpiresAt)) {
    return null;
  }
  if (typeof expires.key !== "string" && expires.key !== null) {
    return null;
  }
  return { at: expires.at as ExpiresAt, key: expires.key };
}

/** A copy of `message` with `patch` applied to its metadata. The copy is rebuilt
 *  through its JSON, so it is an instance of the same class, and the
 *  original is untouched: `adoptFrom` and `getMessages` share instances. */
export function withMetadata(message: smoltalk.Message, patch: MetadataPatch): smoltalk.Message {
  const metadata: Record<string, unknown> = { ...metadataOf(message) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete metadata[key];
    } else {
      metadata[key] = value;
    }
  }
  const json = { ...message.toJSON(), metadata } as smoltalk.MessageJSON;
  if (Object.keys(metadata).length === 0) {
    delete json.metadata;
  }
  return smoltalk.messageFromJSON(json);
}
