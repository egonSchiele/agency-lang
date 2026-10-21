# The timeout on `std::http` fetches

`fetch`, `fetchJSON` and `fetchMarkdown` take `timeout: number = 30000`,
milliseconds, as their last parameter. `0` means no limit, as it does for
`exec` in `std::shell`. The default is `DEFAULT_FETCH_TIMEOUT_MS` in
`lib/stdlib/http.ts` and is repeated as the parameter default in
`stdlib/http.agency`, because the default in the Agency source is what the
tool description shows the model.

## One signal for the whole request

`requestSignal` joins the run's abort signal with `AbortSignal.timeout(ms)`
through `AbortSignal.any`. The request is sent and its body is read under
that one signal, so the limit covers the connection, the headers and the
body together: a server that answers the headers and then stalls the body
still runs out of time. The run's signal stays in the pair, so a cancel or
a guard trip tears the request down as before, and `AbortSignal.any` keeps
the reason of whichever source fired first.

## A timeout is a failure, a cancel is not

A timeout aborts with a `DOMException` named `TimeoutError`, which
`isAbortError` does not match. `runHttp` checks `isTimeoutError` first and
throws an ordinary `Error` naming the URL and the limit. The `try` around
`_fetch` turns an `Error` into a `Failure` the model can route around,
while an `AgencyCancelledError` is rethrown to the runner. Keep that
order: if a timeout were reported as a cancellation, the model would never
see it.

## Callers that pass no limit

The exported helpers `_fetch`, `_fetchJSON` and `_fetchMarkdown` default
the limit themselves, because a `std::http` module compiled before this
parameter existed still calls them with six arguments. `oauth.ts`,
`speech.ts` and `browserUse.ts` run their own `fetch` and share `runHttp`
only for the catch side; they pass no limit and are unchanged. `runHttp`
takes the limit as an optional argument for when they do.
