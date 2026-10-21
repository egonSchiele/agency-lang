# The timeout on `std::http` fetches

`fetch`, `fetchJSON` and `fetchMarkdown` in `std::http` give up after 30
seconds unless the call says otherwise. Before this, a fetch ran until the
server answered, a guard tripped, or the run was cancelled: in trace
wX5GvrUq a page that never answered held the agent for the rest of its
budget. This page records how the limit works and the two decisions behind
it.

## What the limit covers

One limit covers the whole request: the connection, the headers and the
body. The body is read by `readBodyBytesCapped` under the same signal that
the request was sent with, so a server that answers the headers at once
and then drips the body still runs out of time. The clock starts when the
request is made, not when the body starts.

## How it is wired

`requestSignal` in `lib/stdlib/http.ts` joins the run's own abort signal
with `AbortSignal.timeout(ms)` through `AbortSignal.any`. The run's signal
is still in the pair, so a cancel or a guard trip tears the request down
exactly as before. A limit of `0` returns the run's signal alone, which is
"no limit", the same meaning `0` has for the `timeout` argument of
`std::shell`'s `exec`.

A timeout aborts with a `DOMException` named `TimeoutError`. `isAbortError`
in `lib/runtime/errors.ts` matches only `AbortError`, so `runHttp` checks
`isTimeoutError` first and turns it into an ordinary `Error`:

```text
Request to https://example.com/slow timed out after 30 seconds. Do not
retry it as is: pass a larger timeout if the source is slow, or use a
different source.
```

That is an `Error` and not an `AgencyCancelledError` on purpose. The `try`
around `_fetch` in `stdlib/http.agency` turns an `Error` into a `Failure`
the model can read, while a cancellation is rethrown so it reaches the
runner. A timeout is the model's problem to route around; a cancel is not.

When the run is cancelled and the timeout fires at about the same time,
`AbortSignal.any` aborts with the reason of whichever source fired first,
so the error the catch sees is the right one. The tests in
`lib/stdlib/http.test.ts` cover a cancel during a long limit and a timeout
with no cancel.

## The argument

Each of the three functions takes `timeout: number = 30000`, in
milliseconds, as its last parameter, so an existing call that names its
arguments by position is unchanged. The name and unit follow `exec` and
`browserUse`. The default lives in one place, `DEFAULT_FETCH_TIMEOUT_MS`
in `http.ts`, and is repeated as the parameter default in the Agency
source because a default there is what the tool description shows the
model.

## What is not covered

The other stdlib modules that call `fetch` themselves and share `runHttp`
for the catch side (`oauth.ts`, `speech.ts`, `browserUse.ts`) pass no
timeout and keep their old behaviour. `runHttp` takes the limit as an
optional argument so each can add one when it needs it.
