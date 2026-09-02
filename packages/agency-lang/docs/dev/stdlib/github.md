# `std::github`

`std::github` gives an agent typed tools for pull requests and issues:
eleven reads and seven writes, each behind its own interrupt effect. The
spec is `packages/agency-lang/2026-09-01-std-github-spec.md`. This doc
records the decisions a reader needs before changing the module.

Files: `stdlib/github.agency` is the public surface. Under
`lib/stdlib/github/`, `credential.ts` finds the token, `repo.ts` resolves
owner and repo, `request.ts` sends one declared endpoint, `errors.ts` turns a
failed status into a message the model can act on, `args.ts` holds the
argument checks that run before a raise, and `prs.ts` and `issues.ts` declare
the endpoints.

## REST, not the `gh` CLI

Inline review comments have no `gh` porcelain, `gh` output has to be read as
JSON anyway, and quoting a markdown body on a command line is a recurring
source of bugs. The deciding reason is the interrupt payload. Built from a
command line it is a reconstruction of the request. Built from the endpoint
declaration it is the request itself.

Every endpoint is one `GithubEndpoint` declaration: name, method, path
builder, optional body builder, and a zod schema that validates the raw
response and transforms it to the public shape. `_githubRequest` is the only
thing that sends a request, and it validates every successful body, so a
GitHub API change fails with the endpoint name and the first field that did
not match.

## The credential

The token comes from `GITHUB_TOKEN` or `GH_TOKEN`, then `gh auth token`, then
the system keyring under `github-token`. Logging in means `gh auth login`.
There is no OAuth app of our own.

The token never becomes an Agency value, because a checkpoint serializes
every variable. No public function takes or returns a token. Every function
raises its interrupt first, and the token is read only after approval,
inside one TypeScript call with no interrupt point. The resolver is
TypeScript-internal and is not a tool. The `.agency` file imports only the
binding files it needs, which keeps the stdlib's own Agency code from
reaching the token by accident. It is not a sandbox. Any TypeScript import
can read anything, and that accepted risk is what `--agency-only` exists to
close.

## Arguments are settled before the raise

With `owner` and `repo` left empty, a function resolves them from the origin
remote of the agent working directory before raising, so the payload names
the real repository and an "approve always" answer pins to it through
`@always(owner, repo)`. Explicit names are checked against GitHub's own
syntax, since they feed URL paths, the search query, and that approval
scope. `agency agent` sets the working directory. Plain `agency run` does
not, so scripts pass both names or call `setAgentCwd`.

The same rule covers every argument. Paging is clamped, numbers and diff
lines are checked, and a review GitHub would refuse (a `REQUEST_CHANGES`
with no body) is refused first, so a handler judges exactly the request that
will be sent and no approval is spent on a call that cannot succeed.

## The effect vocabulary

One effect per endpoint, with one exception and one consequence.

The exception: `prApprove` is separate from `prReview`, though both post to
the reviews endpoint. Approving is a signed-off judgement that can satisfy
branch protection and unblock a merge, and it is the action people most
often want to forbid by name. `ghPrReview`'s `ReviewEvent` type excludes
`APPROVE`, its docstring points at `ghPrApprove`, and the TypeScript binding
refuses the event as a backstop.

The consequence: GitHub models a pull request as an issue, so the issue
endpoints accept pull request numbers. `ghIssueComment`, `ghIssueClose`, and
`ghIssueLabel` therefore work on pull requests too, under the issue effects.
The owner decided this is a distinction without a difference, so there is no
separate PR-comment effect. `ghIssueGet` is the one place a pull request
number is refused, because the read promises an issue's fields.

## Two requests behind one interrupt

Check runs are keyed by commit SHA, so `ghPrChecks` reads the pull request to
get its head SHA before the check-runs request. `ghPrReviewComment` does the
same when `commitSha` is left empty, and that read runs after the raise but
outside the `destructive` block, so a failed read is not recorded as a
failed mutation. These are the module's only two such cases. The extra
request is a read, forced by the API shape, and not model-controlled.
Auto-pagination was ruled out for the same reason: one approval must not
authorize an unbounded number of requests.

## What is deliberately missing

There is no `ghPrCreate` or `ghPrUpdate`. Creating a pull request needs a
pushed branch, and `std::git` cannot push yet. There is no `ghPrMerge`.
Merging is the most consequential write GitHub offers, the intended flow is
that a human merges after `ghPrApprove`, and a merge function should only
arrive as its own effect with its own spec.

The base URL is the constant `https://api.github.com`. GitHub Enterprise
support is issue #1003. When it lands the value must be read once per
process, never per request, so a mid-run `setEnv` cannot redirect
authenticated calls.
