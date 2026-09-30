/**
 * The one place in the process that sends log events to a Statelog server.
 *
 * A `StatelogClient` lives for one run, but a request it started can outlive
 * that run: nothing waits for a log upload while a program is running. So the
 * list of requests still on their way belongs to the process, not to a client.
 * `exitProcess` waits for that list before the process exits.
 */

export type StatelogPost = {
  url: string;
  apiKey: string;
  body: string;
  timeoutMs: number;
  debugMode: boolean;
};

const pendingPosts: Promise<void>[] = [];

function removePendingPost(post: Promise<void>): void {
  const index = pendingPosts.indexOf(post);
  if (index !== -1) {
    pendingPosts.splice(index, 1);
  }
}

/**
 * Start sending one event and return at once. The request is bounded by
 * `timeoutMs`, so a slow or unreachable server cannot hold up an exit for
 * longer than that. A failure prints only in debug mode, and never throws.
 */
export function sendStatelogPost(post: StatelogPost): void {
  const request = fetch(post.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${post.apiKey}`,
    },
    body: post.body,
    signal: AbortSignal.timeout(post.timeoutMs),
  })
    .then((response) => {
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
