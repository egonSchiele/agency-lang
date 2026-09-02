# `std::github`

`std::github` gives an agent typed tools for pull requests and issues:
eleven reads and eight writes, each behind its own interrupt effect. The
spec that settled the design is
`packages/agency-lang/2026-09-01-std-github-spec.md`. This doc records the
decisions a reader needs before changing the module, and why each was made.

Files: `stdlib/github.agency` is the public surface. Under
`lib/stdlib/github/`, `credential.ts` finds the token, `repo.ts` resolves
owner and repo, `request.ts` sends one declared endpoint, `errors.ts` turns a
failed status into a message the model can act on, `args.ts` holds the
argument checks that run before a raise, and `prs.ts` and `issues.ts` declare
the endpoints.

## Why REST and not the `gh` CLI

Both harnesses we studied (opencode, hermes) shell out to `gh` and keep the
GitHub knowledge in prompts. We chose the REST API instead. Inline review
comments have no `gh` porcelain, so both harnesses drop to `gh api` for
them anyway. `gh` output has to be read as JSON regardless. Quoting a
markdown body on a command line is a recurring source of bugs. An interrupt
payload built from a command line is a reconstruction of the request. A
payload built from the endpoint declaration is the request itself.

Every endpoint is one `GithubEndpoint` declaration: name, method, path
builder, optional body builder, and a zod schema that validates the raw
response and transforms it to the public shape. `_githubRequest` is the only
thing that sends a request, and it validates every successful body, so a
GitHub API change fails loudly with the endpoint name and the first field
that did not match.

## The credential chain

The token comes from `GITHUB_TOKEN` or `GH_TOKEN`, then `gh auth token`, then
the system keyring under `github-token`. Logging in means `gh auth login`.
There is no OAuth app of our own. A miss is not cached, and a
401 drops the cached token so a replaced one is picked up.

## Why the token never becomes an Agency value

A checkpoint serializes every variable, so a token in any Agency variable at
any raise lands on disk. Three rules follow:

- No public function takes or returns a token. `packages/github`, the older
  npm package, puts `token: string = ""` on every function; a parameter is a
  local, and locals are checkpointed.
- The interrupt comes before the token. Every function raises first, and the
  token is read only after approval, inside one TypeScript call with no
  interrupt point. One approval gates both the read and the action.
- Nothing reads the token without an approved interrupt in front of it. The
  resolver is TypeScript-internal, never a tool, and there is no
  `ghAuthStatus`-style helper.

The `.agency` file imports only the binding files it needs, never
`credential.ts` or `request.ts`. That keeps the stdlib's own Agency code
from reaching the token by accident. It is not a sandbox. Any TypeScript
import can read anything, and that accepted risk is what `--agency-only`
exists to close.

## Owner and repo are resolved before the raise

With `owner` and `repo` left empty, a function resolves them from the origin
remote of the agent working directory. This happens before the raise, so the
payload names the real repository and an "approve always" answer pins to it
through `@always(owner, repo)`. Raising with the raw defaults would pin to
`("", "")`. Explicit names are checked against GitHub's own syntax, since
they feed URL paths, the search query, and that approval scope. `agency
agent` sets the working directory; plain `agency run` does not, so scripts
pass both names or call `setAgentCwd`.

The same rule covers every argument: paging is clamped and numbers are
checked before the raise, so a handler judges exactly the request that will
be sent.

## Two departures from one effect per endpoint

`prComment` and `issueComment` are separate effects that hit the same
endpoint, because GitHub models a pull request as an issue. Approving issue
comments for triage must not silently grant commenting on pull requests.

`prApprove` is separate from `prReview`, though both post to the reviews
endpoint. Approving is a signed-off judgement that can satisfy branch
protection and unblock a merge, and it is the action people most often want
to forbid by name. `ghPrReview`'s `ReviewEvent` type excludes `APPROVE`, its
docstring points at `ghPrApprove`, and the TypeScript binding refuses the
event as a backstop.

## Two requests behind one interrupt

Check runs are keyed by commit SHA, so `ghPrChecks` first reads the pull
request to get its head SHA. `ghPrReviewComment` does the same when
`commitSha` is left empty. These are the module's only two such cases. The
extra request is a read, forced by the API shape, and not model-controlled.
A future function needing a hidden second request gets the same explicit
call-out. Auto-pagination was ruled out for the same reason: one approval
must not authorize an unbounded number of requests.

## What is deliberately missing

There is no `ghPrCreate` or `ghPrUpdate`. Creating a pull request needs a
pushed branch, and `std::git` cannot push yet. There is no
`ghPrMerge` on purpose. Merging is the most consequential write GitHub
offers, the intended flow is that a human merges after `ghPrApprove`, and a
merge function should only arrive as its own effect with its own spec.

The base URL is the constant `https://api.github.com`. GitHub Enterprise
support is issue #1003, and when it lands the value must be read once per
process, never per request, so a mid-run `setEnv` cannot redirect
authenticated calls.

## Testing

Unit tests stub `fetch` and cover the logic: credential precedence, remote
URL parsing, error mapping, argument checks, and every endpoint's request
and response shape. The execution tests in `tests/agency/github/` cover what
unit tests cannot reach: that a rejection produces a failure and sends
nothing, that approving one effect does not approve another, that payloads
carry the resolved repository and clamped paging, and that `@always` pins
both fields. They use the repo's deterministic fetch mode (`fetchMocks` in
the `.test.json`), and every rejection test declares the mock anyway, so a
rejection that stopped blocking would let the call succeed and fail the
test for the right reason.
