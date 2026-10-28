import { describe, it, expect } from "vitest";
import {
  cachedFetch,
  FETCH_CACHE_MODULE,
  MAX_CACHED_CHARS,
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
  recordToolCall(run.stack, tool, run.threads.lineageOf(thread));
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

describe("cachedFetch and recordFetch", () => {
  it("a second GET of the same page in a tool call gets the stored result, whichever spelling", async () => {
    await inTestFrame(async (run) => {
      const thread = run.threads.getOrCreateActive();
      await inToolCall(run, thread, async (run) => {
        expect(cachedFetch(run, get("https://www.example.com/about"), false)).toBeNull();
        recordFetch(run, get("https://www.example.com/about"), "the about page");
      });
      await inToolCall(run, thread, async (run) => {
        expect(cachedFetch(run, get("https://example.com/about/#x"), false)).toEqual({
          value: "the about page",
        });
      });
    });
  });

  it("keeps a JSON result as it was, null included", async () => {
    await inTestFrame(async (run) => {
      const thread = run.threads.getOrCreateActive();
      const json = { url: "https://example.com/api", method: "GET", body: null, tool: "fetchJSON" };
      const empty = { ...json, url: "https://example.com/empty" };
      await inToolCall(
        run,
        thread,
        async (run) => {
          recordFetch(run, json, { items: [1, 2] });
          recordFetch(run, empty, null);
          expect(cachedFetch(run, json, false)).toEqual({ value: { items: [1, 2] } });
          expect(cachedFetch(run, empty, false)).toEqual({ value: null });
        },
        { module: "stdlib/http.agency", registeredName: "fetchJSON" },
      );
    });
  });

  it("never caches a request that sets headers", async () => {
    await inTestFrame(async (run) => {
      const thread = run.threads.getOrCreateActive();
      const withHeaders = {
        ...get("https://example.com/api"),
        headers: { Accept: "application/json" },
      };
      await inToolCall(run, thread, async (run) => {
        recordFetch(run, get("https://example.com/api"), "<html>the page</html>");
        // The same URL asking for JSON is another answer, not a repeat.
        expect(cachedFetch(run, withHeaders, false)).toBeNull();
        recordFetch(run, withHeaders, { json: true });
        expect(cachedFetch(run, get("https://example.com/api"), false)).toEqual({
          value: "<html>the page</html>",
        });
        // Empty headers are no headers.
        expect(cachedFetch(run, { ...get("https://example.com/api"), headers: {} }, false)).toEqual(
          {
            value: "<html>the page</html>",
          },
        );
      });
    });
  });

  it("keeps the cache in a globals module of its own, not __internal", async () => {
    await inTestFrame(async (run) => {
      const thread = run.threads.getOrCreateActive();
      await inToolCall(run, thread, async (run) => {
        recordFetch(run, get("https://example.com/a"), "a page");
      });
      expect(
        run.globals.get(FETCH_CACHE_MODULE, "cache").entries["https://example.com/a"].value,
      ).toBe("a page");
      expect(run.globals.get("__internal", "__fetchCache")).toBeUndefined();
    });
  });

  it("drops the oldest results past the cap, and never keeps one larger than the cap", async () => {
    await inTestFrame(async (run) => {
      const thread = run.threads.getOrCreateActive();
      const half = "x".repeat(MAX_CACHED_CHARS / 2);
      await inToolCall(run, thread, async (run) => {
        recordFetch(run, get("https://example.com/1"), half);
        recordFetch(run, get("https://example.com/2"), half);
        recordFetch(run, get("https://example.com/3"), half);
        // The first page went to make room, so it is fetched again.
        expect(cachedFetch(run, get("https://example.com/1"), false)).toBeNull();
        expect(cachedFetch(run, get("https://example.com/2"), false)).toEqual({ value: half });
        expect(cachedFetch(run, get("https://example.com/3"), false)).toEqual({ value: half });
        // A result too large to keep replaces nothing else, and its URL
        // misses, so the next call fetches it.
        recordFetch(run, get("https://example.com/big"), "x".repeat(MAX_CACHED_CHARS + 1));
        expect(cachedFetch(run, get("https://example.com/big"), false)).toBeNull();
        expect(cachedFetch(run, get("https://example.com/3"), false)).toEqual({ value: half });
      });
    });
  });

  it("refresh: true, a POST, another tool's fetch, and a fetch from code are never cached", async () => {
    await inTestFrame(async (run) => {
      const thread = run.threads.getOrCreateActive();
      await inToolCall(run, thread, async (run) => {
        recordFetch(run, get("https://example.com/a"), "a page");
        expect(cachedFetch(run, get("https://example.com/a"), true)).toBeNull();
        const post = { url: "https://example.com/a", method: "POST", body: "x", tool: "fetch" };
        recordFetch(run, post, "a page");
        expect(cachedFetch(run, post, false)).toBeNull();
        // The same URL through another fetch function is not this tool.
        expect(cachedFetch(run, get("https://example.com/a", "fetch"), false)).toBeNull();
      });
      // A tool of its own that fetches through fetchMarkdown, such as a
      // data connector, always gets a fresh fetch.
      const connector = { module: "stdlib/data/hackernews.agency", registeredName: "topStories" };
      await inToolCall(
        run,
        thread,
        async (run) => {
          expect(cachedFetch(run, get("https://example.com/a"), false)).toBeNull();
          recordFetch(run, get("https://example.com/c"), "a page");
        },
        connector,
      );
      await inToolCall(run, thread, async (run) => {
        expect(cachedFetch(run, get("https://example.com/c"), false)).toBeNull();
      });
      // The same run, outside a tool call: the page was fetched, and it
      // is fetched again, because this is a program fetching.
      expect(cachedFetch(run, get("https://example.com/a"), false)).toBeNull();
      recordFetch(run, get("https://example.com/b"), "a page");
      await inToolCall(run, thread, async (run) => {
        expect(cachedFetch(run, get("https://example.com/b"), false)).toBeNull();
      });
    });
  });

  it("counts a fetch on the conversation's thread or an ancestor, not one on an unrelated thread", async () => {
    await inTestFrame(async (run) => {
      const parent = run.threads.getOrCreateActive();
      await inToolCall(run, parent, async (run) => {
        recordFetch(run, get("https://example.com/parent"), "a page");
      });
      // A subthread starts with its parent's messages, so the page is in
      // its conversation.
      const child = run.threads.createAndReturnSubthread();
      await inToolCall(run, child, async (run) => {
        expect(cachedFetch(run, get("https://example.com/parent"), false)).not.toBeNull();
        recordFetch(run, get("https://example.com/child"), "a page");
      });
      // The parent never saw the child's fetch.
      await inToolCall(run, parent, async (run) => {
        expect(cachedFetch(run, get("https://example.com/child"), false)).toBeNull();
      });
      // A fresh thread shares no messages with either.
      const other = run.threads.createAndReturnThread();
      await inToolCall(run, other, async (run) => {
        expect(cachedFetch(run, get("https://example.com/parent"), false)).toBeNull();
      });
      // A thread the store does not know has no lineage, so the cache
      // misses and records nothing the next call could hit.
      const unknown = new MessageThread();
      expect(run.threads.lineageOf(unknown)).toEqual([]);
      await inToolCall(run, unknown, async (run) => {
        recordFetch(run, get("https://example.com/unknown"), "a page");
        expect(cachedFetch(run, get("https://example.com/unknown"), false)).toBeNull();
      });
    });
  });
});
