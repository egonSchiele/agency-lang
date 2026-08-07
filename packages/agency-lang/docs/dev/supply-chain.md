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

**First-party packages are excluded** because publish-then-immediately-use is
the normal dev loop for smoltalk/tarsec/typestache. The exclusion is by
package name and covers all versions. If you ever need one specific fresh
version of a third-party package right now, prefer the versioned exclusion
form (`name@x.y.z`, pnpm ≥ 10.19) over lowering the global window.

## Everything else in the block

- `blockExoticSubdeps: true` — transitive deps must come from the registry
  (no git/tarball URLs), so the cooldown and integrity hashes cannot be
  bypassed one level down. The current lockfile has zero exotic sources.
- `allowBuilds` — lifecycle (install) scripts are default-denied since
  pnpm 10; the three packages that request one (`esbuild`, `@google/genai`,
  `protobufjs`) are explicitly denied because everything has worked with them
  blocked all along (esbuild's platform binaries arrive as
  optionalDependencies; its script is only a fallback). A new dependency
  requesting a build script will fail loudly — approve it in this table only
  with a reason.

## Why the pnpm version is pinned in package.json

These settings need pnpm ≥ 10.16 and are **silently ignored** by older pnpm —
which is the failure mode that would quietly turn all of this off. The
repo-root `"packageManager": "pnpm@11.20.0"` field is the single source of
truth: modern pnpm self-switches to that exact version, and CI's
`pnpm/action-setup` reads the same field (the per-workflow `version: 9` pins
were removed for exactly this reason — never reintroduce one, or that
workflow resolves dependencies with the cooldown off).

pnpm 11 itself requires Node ≥ 22.13, which is why the engines floor (and the
CI job pinned to the exact floor) sits at 22.13.0 rather than commander v15's
22.12.

## What this deliberately does not do

Vendoring the tree was considered and rejected: the closure includes
platform-binary packages and high-churn SDKs, and full vendoring converts
"might install a compromised version" into "quietly stops taking security
fixes". The one vendored dependency, commander, exists for functional reasons
(see `docs/dev/vendored-commander.md`), not as supply-chain policy.
