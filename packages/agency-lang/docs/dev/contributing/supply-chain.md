# Dependency supply-chain hardening

Agency's production dependency closure is ~211 packages (15 direct — the tree
comes mostly via smoltalk's LLM SDKs). The realistic npm attack is a malicious
*new version* published from a compromised maintainer account, caught by the
ecosystem within hours or days. The defenses below close that window without
vendoring anything; they live in the repo-root `pnpm-workspace.yaml` and
`package.json`.

## The release-age cooldown

```yaml
minimumReleaseAge: 10080        # minutes: 7 days
minimumReleaseAgeExclude:
  - smoltalk
  - smoltalk-llama-cpp
  - tarsec
  - typestache
```

pnpm will not resolve any dependency version until it has been public for a
week. Installs from the committed lockfile are unaffected (those versions are
already pinned with integrity hashes); the cooldown bites exactly when
resolution happens — `pnpm add`, `pnpm update`, or a range that no longer
matches the lockfile. Verified behaviorally: with `openai@7.4.0` four days
old and `7.3.0` at 6.99 days, a fresh `pnpm add openai` resolved `7.2.0`
(8 days old).

**First-party packages are excluded** because publishing one and immediately
using it is the normal dev loop. `smoltalk-llama-cpp` is on the list for a
second reason: exact-version requests are gated too, and the local-model CI
workflow installs it at a freshly bumped pin. The exclusion is by package
name and covers all versions. If you ever need one specific fresh
version of a third-party package right now, prefer the versioned exclusion
form (`name@x.y.z`, pnpm ≥ 10.19) over lowering the global window.

## Everything else in the block

- `blockExoticSubdeps: true` — transitive deps must come from the registry
  (no git/tarball URLs), so the cooldown and integrity hashes cannot be
  bypassed one level down. The current lockfile has zero exotic sources.
- `allowBuilds` — lifecycle (install) scripts are default-denied since
  pnpm 10; the packages that request one (`esbuild`, `@google/genai`,
  `protobufjs`, `tesseract.js`, and `node-llama-cpp`, which only the
  local-model CI workflow installs) are explicitly denied because everything
  works with them blocked (esbuild's and node-llama-cpp's platform binaries
  arrive as optionalDependencies; their scripts are only fallbacks). A
  dependency requesting a build script that is not in the table fails the
  install outright, in CI and locally — approve it in this table only with a
  reason. The local-model workflow ran into exactly that for a month: every
  post-merge run died at `pnpm add smoltalk-llama-cpp` before a test ran.

## Why the pnpm version is pinned in package.json

These settings need pnpm >= 10.16, and older pnpm **silently ignores** them.
That is the failure mode that would quietly turn all of this off. The
repo-root `"packageManager": "pnpm@12.4.2"` field is the single source of
truth, and three separate mechanisms honor it. pnpm >= 10 switches to the
pinned version natively via `managePackageManagerVersions`, which is on by
default. Corepack shims do the same where Corepack is enabled. CI's
`pnpm/action-setup` reads the field when no `version` input is given, which
is why the per-workflow `version: 9` pins were removed. Never reintroduce
one, or that workflow resolves dependencies with the cooldown off.

The unprotected case is a global pnpm older than 10. It ignores both the
field and the settings, so if `pnpm --version` inside the repo does not print
12.4.2, upgrade it.

The pinned pnpm is itself subject to the cooldown in spirit: the lockfile's
first document resolves `pnpm` and its `@pnpm/exe.*` binaries at the pinned
version, and `pnpm` is not in `minimumReleaseAgeExclude`, so when bumping
`packageManager` choose a release that is at least 7 days old.

The engines floor of Node 22.13 was raised above commander v15's 22.12 for
pnpm 11. pnpm 12 runs on Node 18+, so nothing requires 22.13 today; the floor
stays there until lowering it is its own change.

## What this deliberately does not do

Vendoring the tree was considered and rejected: the closure includes
platform-binary packages and high-churn SDKs, and full vendoring converts
"might install a compromised version" into "quietly stops taking security
fixes". The one vendored dependency, commander, exists for functional reasons
(see `docs/dev/cli/vendored-commander.md`), not as supply-chain policy.
