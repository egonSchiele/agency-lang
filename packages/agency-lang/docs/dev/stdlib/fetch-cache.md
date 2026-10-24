# The fetch cache: a URL a conversation fetched once is not fetched again

In trace wX5GvrUq the researcher fetched one about page ten times and one
podcast transcript eight times, each copy into the same thread, until a
request carried about 600,000 tokens. The repeated-call guard
(`tool-loop-guards.md`) never fired, because the repeats differed in how
`allowedDomains` was spelled. The fetch cache is the fix (ADI-45): when a
model tool call GETs a URL that the same conversation already fetched, the
tool returns this instead of the page:

> Already fetched this URL earlier in this conversation (fetchMarkdown
> call 2, as https://www.3blue1brown.com/about); its content is in the
> conversation above. Fetch it again only if you expect it to have
> changed, by passing `refresh: true`.

The note is short on purpose: the page is already in the model's context,
and a second copy is what cost the tokens.

## Where it is

- `lib/runtime/fetchCache.ts`: `normalizeFetchUrl`, `fetchCacheNote`,
  `recordFetch`, and `fetchedInThisConversation`. Pure functions over the
  run, with no Node import, so they run in a browser.
- `lib/stdlib/http.ts`: `_fetchCacheNote`, which the Agency functions
  call, and `remember`, which the three `_fetch*` helpers call after a
  fetch that did not fail.
- `stdlib/http.agency`: each of `fetch`, `fetchJSON`, and
  `fetchMarkdown` asks for the note on its first line, before it raises
  its interrupt, and takes `refresh: boolean = false`.

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

**Only the model's own fetch is cached.** `fetchCacheNote` and
`recordFetch` do nothing unless the fetch function itself is the tool the
model called (`directToolCall`: the record the loop left on
`run.toolInvocationStack` names a function from `stdlib/http.agency`
with this function's registered name, which a `rename` or `partial`
keeps). Two cases are deliberately outside that. A program that fetches
the same URL in a loop is polling, not repeating itself, and gets the
page every time. And a tool of its own that fetches on its own account,
such as a data connector reading an API through `fetchJSON`
(`connectorFetch` in `stdlib/data/connector.agency`), expects JSON back
and would break on a note; the model called the connector, not the
fetch, so a repeat is the connector's business.

**Only a GET with no body.** A POST is an action, and two POSTs to one
URL are two actions.

**Only this conversation.** An entry records the thread whose
conversation the fetch's result went to, and a hit needs that thread to
be the current conversation's thread or one of its ancestors. A subthread
starts with its parent's messages, so a page the parent fetched is in its
context; a fresh `thread` shares nothing, so a reviewer on its own thread
fetches the page itself. The note says the content is in the
conversation above, and this rule is what makes that true. The cache
therefore keeps no content, only the URL as the model first wrote it, the
tool, the thread, and the fetch's number in the run.

A tool body cannot find that thread by itself: the tool loop runs every
body on a fresh, empty thread store (`invokeOnFreshThreadStore`), so that
an `llm()` call inside a tool does not append to the prompt's thread. So
the loop records the conversation for it. `runInvokeStep` in `prompt.ts`
calls `recordToolCall` with `ThreadStore.lineageOf(messages)`, the
prompt's thread and its ancestors nearest first, and the tool's module
and registered name, on the call's branch stack, which the body reads as
`run.toolInvocationStack`. `recordFetch` files an entry under the first
id; `fetchCacheNote` hits when the entry's thread is anywhere in the
list.

**A hit asks no one.** The Agency function checks the cache before it
raises `std::http::fetchMarkdown`. Nothing is fetched on a hit, so there
is nothing to approve, and a policy that prompts on fetches does not
prompt for a page it already allowed.

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

- `lib/runtime/fetchCache.test.ts`: the key, the three conditions, and
  the thread rule, against a test run.
- `tests/agency-js/fetch-cache`: a scripted model calls `fetchMarkdown`
  on the same page in two spellings (page, then note), with
  `refresh: true` (page), and then from a fork branch, which sees the
  parent's fetch and its own; a second node fetches from code twice and
  gets the page both times. The tool results are read back from the
  thread with `getThread`.
- `evals/researcher/thom-yorke-how-he-learned` has a `no-repeated-retrieval`
  grader that counts tool calls, so a cache hit still counts there as a
  call; it is the floor under this cache, as its README says.
