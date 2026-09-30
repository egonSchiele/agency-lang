/**
 * The one place in the process that sends log events to a Statelog server.
 *
 * A `StatelogClient` lives for one run, but a request it started can outlive
 * that run: nothing waits for a log upload while a program is running. So the
 * list of requests still on their way belongs to the process, not to a client.
 * `exitProcess` waits for that list before the process exits.
 *
 * The same reasoning covers a refused API key. A served program makes a new
 * client for every request, so a refusal recorded on a client would be
 * forgotten by the next request. It is recorded here, for the process, and
 * it expires.
 */

import { createHash } from "node:crypto";

export type StatelogPost = {
  host: string;
  projectId: string;
  apiKey: string;
  body: string;
  timeoutMs: number;
  debugMode: boolean;
};

const pendingPosts: Promise<void>[] = [];

// How long a refusal stops sending. The Statelog server also answers 401
// when its own database lookup fails, and 403 for an account that is not
// approved yet, so a refusal can stop being true. After this long the next
// event is sent, and a server that still refuses starts the wait again.
const REFUSAL_MS = 5 * 60 * 1000;

type Refusal = { target: string; until: number };

// One entry per host, project, and key that the server refused. The key is
// part of the entry because a hosted server runs many invocations in one
// process, each with its own key: a revoked key must not stop a valid one
// for the same project. The entry holds a hash, so the key is not kept in a
// second place.
const refusals: Refusal[] = [];

function targetOf(post: StatelogPost): string {
  const keyHash = createHash("sha256").update(post.apiKey).digest("hex");
  return JSON.stringify([post.host, post.projectId, keyHash]);
}

function isRefused(target: string): boolean {
  const refusal = refusals.find((entry) => entry.target === target);
  return refusal !== undefined && Date.now() < refusal.until;
}

/**
 * A 401 or 403 means the server refused this key for this project, and the
 * next request would be refused the same way. Stop sending with that key to
 * that host and project for `REFUSAL_MS`, and say so once. Requests already
 * on their way come back refused too, so only the first one prints.
 */
function recordRefusal(post: StatelogPost, status: number): void {
  const target = targetOf(post);
  if (isRefused(target)) return;
  const until = Date.now() + REFUSAL_MS;
  const index = refusals.findIndex((entry) => entry.target === target);
  if (index === -1) {
    refusals.push({ target, until });
  } else {
    refusals[index] = { target, until };
  }
  console.warn(
    `Statelog: ${post.host} refused the API key for project "${post.projectId}" (HTTP ${status}). Remote logging to it is off for the next ${REFUSAL_MS / 60_000} minutes.`,
  );
}

function removePendingPost(post: Promise<void>): void {
  const index = pendingPosts.indexOf(post);
  if (index !== -1) {
    pendingPosts.splice(index, 1);
  }
}

/**
 * Start sending one event and return at once. The request is bounded by
 * `timeoutMs`, so a slow or unreachable server cannot hold up an exit for
 * longer than that. A failure other than a refused key prints only in debug
 * mode. Throws only when `host` is not a URL.
 */
export function sendStatelogPost(post: StatelogPost): void {
  if (isRefused(targetOf(post))) return;
  const request = fetch(new URL("/api/logs", post.host).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${post.apiKey}`,
    },
    body: post.body,
    signal: AbortSignal.timeout(post.timeoutMs),
  })
    .then((response) => {
      if (response.status === 401 || response.status === 403) {
        recordRefusal(post, response.status);
        return;
      }
      if (!response.ok && post.debugMode) {
        console.error(`Failed to send statelog: HTTP ${response.status}`);
      }
    })
    .catch((err) => {
      if (post.debugMode) console.error("Failed to send statelog:", err);
    });
  const tracked: Promise<void> = request.finally(() => removePendingPost(tracked));
  pendingPosts.push(tracked);
}

/**
 * Wait for every log request still on its way, from every run in this
 * process. Code inside Agency calls `exitProcess`, which does this first. A
 * TypeScript program that runs a node and then calls `process.exit()` itself
 * should await this before it does. A process that ends on its own does not
 * need it: Node keeps running until open requests finish.
 */
export async function flushPendingStatelogPosts(): Promise<void> {
  if (pendingPosts.length === 0) return;
  await Promise.allSettled([...pendingPosts]);
}
