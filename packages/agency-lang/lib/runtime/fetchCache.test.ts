import { describe, it, expect } from "vitest";
import {
  fetchCacheNote,
  normalizeFetchUrl,
  recordToolCall,
  recordFetch,
  type FetchRequest,
} from "./fetchCache.js";
import { MessageThread } from "./state/messageThread.js";
import { inFrameOf, makeMockCtx } from "./__tests__/testHelpers.js";
import { runAsToolInvocation } from "./toolInvocation.js";
import type { Run } from "./asyncContext.js";

/** The fetch cache: which spellings of a URL are one page, when a fetch
 *  is cached at all, and which conversations a cached fetch counts for.
 *  See docs/dev/stdlib/fetch-cache.md. */

function get(url: string, tool = "fetchMarkdown"): FetchRequest {
  return { url, method: "GET", body: null, tool };
}

/** Run `fn` under a test run with a real thread store, since the cache
 *  reads the active thread. */
function inTestFrame<T>(fn: (run: Run) => Promise<T>): Promise<T> {
  const ctx = makeMockCtx();
  return inFrameOf(ctx, ctx.stateStack, fn);
}

/** Run `fn` inside a tool invocation of `tool` whose result goes to
 *  `thread`, the way the tool loop enters one: the call is recorded on
 *  the branch stack first. The only place the cache works. */
function inToolCall<T>(
  run: Run,
  thread: MessageThread,
  fn: (run: Run) => Promise<T>,
  tool: { module: string; registeredName: string } = {
    module: "stdlib/http.agency",
    registeredName: "fetchMarkdown",
  },
): Promise<T> {
  recordToolCall(run.stack, { conversation: run.threads.lineageOf(thread), tool });
  return runAsToolInvocation(run, run.stack, fn);
}

describe("normalizeFetchUrl", () => {
  it("drops the fragment, a trailing slash, and a leading www, and lowercases the host", () => {
    expect(normalizeFetchUrl("HTTPS://WWW.Example.com/About/#team")).toBe(
      "https://example.com/About",
    );
    expect(normalizeFetchUrl("https://example.com/about/")).toBe("https://example.com/about");
    expect(normalizeFetchUrl("https://example.com")).toBe("https://example.com");
  });

  it("keeps the query and the port, since they name another page or server", () => {
    expect(normalizeFetchUrl("https://example.com/list?page=2")).toBe(
      "https://example.com/list?page=2",
    );
    expect(normalizeFetchUrl("http://localhost:8080/x")).toBe("http://localhost:8080/x");
  });

  it("is null for something that is not a URL", () => {
    expect(normalizeFetchUrl("not a url")).toBeNull();
  });
});

describe("fetchCacheNote and recordFetch", () => {
  it("a second GET of the same page in a tool call gets the note, whichever spelling", async () => {
    await inTestFrame(async (run) => {
      const thread = run.threads.getOrCreateActive();
      await inToolCall(run, thread, async (run) => {
        expect(fetchCacheNote(run, get("https://www.example.com/about"), false)).toBeNull();
        recordFetch(run, get("https://www.example.com/about"));
      });
      await inToolCall(run, thread, async (run) => {
        const note = fetchCacheNote(run, get("https://example.com/about/#x"), false);
        expect(note).toContain("Already fetched this URL earlier in this conversation");
        expect(note).toContain("fetchMarkdown call 1, as https://www.example.com/about");
        expect(note).toContain("refresh: true");
      });
    });
  });

  it("refresh: true, a POST, another tool's fetch, and a fetch from code are never cached", async () => {
    await inTestFrame(async (run) => {
      const thread = run.threads.getOrCreateActive();
      await inToolCall(run, thread, async (run) => {
        recordFetch(run, get("https://example.com/a"));
        expect(fetchCacheNote(run, get("https://example.com/a"), true)).toBeNull();
        const post = { url: "https://example.com/a", method: "POST", body: "x", tool: "fetch" };
        recordFetch(run, post);
        expect(fetchCacheNote(run, post, false)).toBeNull();
        // The same URL through another fetch function is not this tool.
        expect(fetchCacheNote(run, get("https://example.com/a", "fetch"), false)).toBeNull();
      });
      // A tool of its own that fetches through fetchMarkdown, such as a
      // data connector, is handed the page, never the note.
      const connector = { module: "stdlib/data/hackernews.agency", registeredName: "topStories" };
      await inToolCall(
        run,
        thread,
        async (run) => {
          expect(fetchCacheNote(run, get("https://example.com/a"), false)).toBeNull();
          recordFetch(run, get("https://example.com/c"));
        },
        connector,
      );
      await inToolCall(run, thread, async (run) => {
        expect(fetchCacheNote(run, get("https://example.com/c"), false)).toBeNull();
      });
      // The same run, outside a tool call: the page was fetched, and the
      // note is still withheld, because this is a program fetching.
      expect(fetchCacheNote(run, get("https://example.com/a"), false)).toBeNull();
      recordFetch(run, get("https://example.com/b"));
      await inToolCall(run, thread, async (run) => {
        expect(fetchCacheNote(run, get("https://example.com/b"), false)).toBeNull();
      });
    });
  });

  it("counts a fetch on the conversation's thread or an ancestor, not one on an unrelated thread", async () => {
    await inTestFrame(async (run) => {
      const parent = run.threads.getOrCreateActive();
      await inToolCall(run, parent, async (run) => {
        recordFetch(run, get("https://example.com/parent"));
      });
      // A subthread starts with its parent's messages, so the page is in
      // its conversation.
      const child = run.threads.createAndReturnSubthread();
      await inToolCall(run, child, async (run) => {
        expect(fetchCacheNote(run, get("https://example.com/parent"), false)).not.toBeNull();
        recordFetch(run, get("https://example.com/child"));
      });
      // The parent never saw the child's fetch.
      await inToolCall(run, parent, async (run) => {
        expect(fetchCacheNote(run, get("https://example.com/child"), false)).toBeNull();
      });
      // A fresh thread shares no messages with either.
      const other = run.threads.createAndReturnThread();
      await inToolCall(run, other, async (run) => {
        expect(fetchCacheNote(run, get("https://example.com/parent"), false)).toBeNull();
      });
    });
  });
});
