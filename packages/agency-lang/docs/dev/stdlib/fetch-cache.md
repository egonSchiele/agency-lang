# The fetch cache: a URL a conversation fetched once is not fetched again

In trace wX5GvrUq the researcher fetched one about page ten times and one
podcast transcript eight times, each copy into the same thread, until a
request carried about 600,000 tokens. The repeated-call guard
(`tool-loop-guards.md`) never fired, because the repeats differed in how
`allowedDomains` was spelled. The fetch cache is the fix (ADI-45): when a
model tool call GETs a URL that the same conversation already fetched, the
tool returns what the first fetch returned, with no request and no
interrupt.

**The result, not a pointer to it.** A short note saying "you already
fetched this, use what it returned" saves the tokens of a second copy,
but only if the model can find the first one. It often cannot: tool
results in a thread carry no number to look up, compaction may have
summarized the result away, and a small model loses a page 40 messages
back. A model that cannot find it fetches again with `refresh: true`, so
the note cost a round and saved nothing. The stored result costs the same
tokens as that second fetch, and it costs no request, no approval, and no
round.

**The model is not offered `refresh`.** The agent toolkits bind it
(`fetchMarkdown.partial(refresh: false)` in `webTools()`, and the three
fetch tools of the Agency coding agent), so the parameter is not in the
schema the model sees. The fetch functions keep it for a program that
hands them to a model and wants a fresh page.

## Where it is

- `lib/runtime/fetchCache.ts`: `normalizeFetchUrl`, `cachedFetch`,
  `recordFetch`, `recordToolCall`, and `fetchedInConversation`. Pure
  functions over the run, with no Node import, so they run in a browser.
- `lib/stdlib/http.ts`: `_cachedFetch`, which the Agency functions
  call, and `remember`, which the three `_fetch*` helpers call after a
  fetch that did not fail, with its result.
- `stdlib/http.agency`: each of `fetch`, `fetchJSON`, and
  `fetchMarkdown` asks for the stored result on its first line, before it
  raises its interrupt, and takes `refresh: boolean = false`.

The cache is one object in the run's globals, under the `__internal`
module as `__fetchCache` (`globalstore.md`). That store is what every
tool call of a run shares, what a fork branch gets a copy of, and what
every checkpoint serializes, which is the whole requirement: a fetch in
one tool round must be known in the next, a branch must see the parent's
fetches and its own, and a resumed run must remember what it fetched.

## Decisions

**One key for every spelling.** `normalizeFetchUrl` lowercases the scheme
and host, drops a leading `www.`, drops the fragment, and drops a
trailing slash. The query stays, since `?page=2` is another page, and so
does the port. The trace's repeats were the same page with a slash, a
`www.`, or a fragment added.

**Only the model's own fetch is cached.** `cachedFetch` and
`recordFetch` do nothing unless the fetch function itself is the tool the
model called (`directToolCall`: the record the loop left on
`run.toolInvocationStack` names a function from `stdlib/http.agency`
with this function's registered name, which a `rename` or `partial`
keeps). Two cases are deliberately outside that. A program that fetches
the same URL in a loop is polling, not repeating itself, and gets the
page every time. And a tool of its own that fetches on its own account,
such as a data connector reading an API through `fetchJSON`
(`connectorFetch` in `stdlib/data/connector.agency`), expects JSON back
and expects a fresh answer; the model called the connector, not the
fetch, so a repeat is the connector's business.

**Only a GET with no body.** A POST is an action, and two POSTs to one
URL are two actions.

**Only this conversation.** An entry records the thread whose
conversation the fetch's result went to, and a hit needs that thread to
be the current conversation's thread or one of its ancestors. A subthread
starts with its parent's messages, so a page the parent fetched is in its
context, and a second fetch of it is a repeat. A fresh `thread` shares
nothing, so a reviewer on its own thread, checking the sources, fetches
the page itself. An entry keeps the URL as the model first wrote it, the
tool, the thread, the fetch's number in the run, and the result.

A tool body cannot find that thread by itself: the tool loop runs every
body on a fresh, empty thread store (`invokeOnFreshThreadStore`), so that
an `llm()` call inside a tool does not append to the prompt's thread. So
the loop records the conversation for it. `runInvokeStep` in `prompt.ts`
calls `recordToolCall` with the tool and `ThreadStore.lineageOf(messages)`,
the prompt's thread and its ancestors nearest first, on the call's branch
stack, which the body reads as `run.toolInvocationStack`. `lineageOf` is
a lookup and registers nothing: it runs before every tool call and the
store is saved in every checkpoint, so a thread the store does not know
(an `llm()` call given its own `messages`) gets an empty lineage and the
cache misses. `recordFetch` files an entry under the first id;
`cachedFetch` hits when the entry's thread is anywhere in the list.

The record is written on every pass through `runInvokeStep`, so a fetch
that pauses on its approval interrupt and resumes from outside finds it
again: `remember` then runs on the resumed pass, and the next call for
the URL gets the stored result. `tests/agency-js/fetch-cache-resume` is that path,
the one the trace's prompts took.

**A hit asks no one.** The Agency function checks the cache before it
raises `std::http::fetchMarkdown`. Nothing is fetched on a hit, so there
is nothing to approve, and a policy that prompts on fetches does not
prompt for a page it already allowed.

**The stored results are capped at 500,000 characters**
(`MAX_CACHED_CHARS`). The cache rides in every checkpoint beside the
spill store (`spill.md`), whose cap of 1,000,000 comes from the 10 MB
hosted resume limit, so the two together leave room for two copies and
escaping. Past the cap the oldest entries go. A result larger than the
whole cap is not kept. A URL with no entry is fetched again, so a dropped
entry only costs a request. An entry from a checkpoint saved before
results were stored has no result and misses the same way.

**A failure is not recorded.** `remember` skips a failure result, so a
page that timed out or returned 404 can be tried again. A rejected
interrupt never reaches `remember` at all.

**A race loser's fetches are forgotten.** They were recorded in the
loser's branch globals, which are discarded with the branch, like every
other write the branch made. The ticket leaned the other way; this is the
rule the store already has, and a special case for one global was not
worth it.

**Not in the host.** The ticket offered the host as a home. The host is
the platform (`host.md`); the cache is run state, and the globals already
have the sharing and serialization it needs.

## Tests

- `lib/runtime/fetchCache.test.ts`: the key, the three conditions, the
  thread rule, a JSON result (`null` included), the cap, and an entry
  with no result, against a test run.
- `tests/agency-js/fetch-cache`: the fetch mocks answer a `www.` URL with
  one body and a bare URL with another, and the cache treats the two as
  one page, so a stored result is told from a fresh fetch by its body. A
  scripted model calls `fetchMarkdown` on the same page in two spellings
  (fetched, then stored), with `refresh: true` (fetched), and then from a
  fork branch, which sees the parent's fetch and its own; a second node
  fetches from code in both spellings and gets a fresh fetch both times.
  The tool results are read back from the thread with `getThread`.
- `tests/agency-js/fetch-cache-resume`: the first fetch has no handler,
  so it pauses on its interrupt; the test approves it from TypeScript and
  resumes, and the second call for the same page gets the stored result.
- `evals/researcher/thom-yorke-how-he-learned` has a `no-repeated-retrieval`
  grader that counts tool calls, so a cache hit still counts there as a
  call; it is the floor under this cache, as its README says.
