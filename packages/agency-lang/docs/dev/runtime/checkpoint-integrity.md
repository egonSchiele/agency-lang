# Checkpoint integrity checksums

A checkpoint is the serialized execution state of a paused program, and on the
external resume path (HTTP `/resume`, a checkpoint loaded from disk) it comes
back from a caller who could have edited it — changed a local, raised a budget,
altered which environment variable a paused function is about to read. This
feature gives a host a way to detect that: when a signing key is configured,
every checkpoint carries an HMAC checksum of its own contents in a `signature`
field, and the host can check it with one function call before resuming.

## Embed, do not enforce

The runtime signs but never refuses. No code path in agency-lang rejects a
checkpoint because its signature is missing or wrong. That is deliberate:
editing checkpoints is a supported feature — rewind replays with different
values for a checkpoint's locals, the debugger edits state, `respondToInterrupts`
accepts overrides — and trace mode writes a checkpoint per step that nobody
signs a contract about. Enforcement is the host's policy, not the runtime's:

```ts
import { verifyCheckpointChecksum } from "agency-lang";

// On the resume leg, before calling respondToInterrupts:
if (!verifyCheckpointChecksum(checkpoint)) {
  // refuse the resume — the checkpoint is not the one this host handed out
}
```

`verifyCheckpointChecksum` returns true only when the checkpoint carries a
signature that validates under the configured key (compared in constant time).
A missing signature returns false — so a caller cannot dodge verification by
stripping the field (the downgrade guard). A host that has not opted in simply
never calls verify.

## Signing is automatic and opt-in

`Checkpoint.fromStateStack` (`lib/runtime/state/checkpointStore.ts`) is the
single chokepoint every checkpoint is created through — interrupt checkpoints,
guard-trip checkpoints, trace snapshots, the stdlib `checkpoint()` builtin. Its
last statement calls `signCheckpoint(checkpoint)`. With no key in the
environment that call is a no-op and nothing about a run changes; with a key,
every checkpoint comes out signed.

The legitimate edit paths re-sign, so an edited checkpoint stays
self-consistent rather than carrying a stale signature:

- `applyOverrides` (`lib/runtime/rewind.ts`) — rewind and resume-time local
  overrides. This also runs on the served resume path with caller-supplied
  overrides; that is fine because a host verifies *before* responding, and the
  re-signed object is never returned to the caller.
- `CheckpointStore.pin` — pinning sets `pinned`/`label`, which are signed
  fields.
- `Checkpoint.clone` — a clone usually changes `id`, which is signed.

Each re-signs only if the checkpoint was signed in the first place.

## What exactly is signed

HMAC-SHA256, hex-encoded, over:

```
"agency.checkpoint.v1" + "\n" + canonicalize(toJSON() minus the signature field)
```

`canonicalize` (`lib/utils/canonicalize.ts`) key-sorts objects at every depth,
so a checkpoint that was serialized, stored, parsed, and re-serialized with
different key order hashes identically. The checksum covers the **whole**
checkpoint — never a hand-picked field list, which would rot the first time a
field was added. New fields (for example the companion `moduleSourceHashes`
code-fingerprint field) are covered automatically because they appear in
`toJSON()`.

One consequence worth knowing: verification recomputes the canonical form from
a checkpoint that came back through `Checkpoint.fromJSON`, i.e. through the zod
schemas in `lib/runtime/state/schemas.ts`. zod strips unknown keys, so a
`toJSON` field missing from its schema (the PR #977 drift class) no longer just
drops data — it makes a valid, untampered checkpoint verify **false**. The
rich-checkpoint round-trip test in `checkpointChecksum.test.ts` pins this; it
is one more reason every new field on a checkpoint-tree `toJSON` must land in
its schema in the same change.

There is no algorithm field in the checkpoint. The algorithm is fixed in code
(no caller-chosen algorithm means no algorithm-confusion attacks); if it ever
changes, the domain tag changes with it.

## The key

- `AGENCY_CHECKPOINT_KEY` holds the signing key. Generate one with
  `openssl rand -hex 32`.
- The key must be at least 32 bytes. A present-but-short key throws
  `CheckpointKeyTooShortError`; an unset key is not an error, it means signing
  is off.
- Rotation: move the retiring key into `AGENCY_CHECKPOINT_KEY_OLD`
  (comma-separated list) and put the new key in `AGENCY_CHECKPOINT_KEY`.
  Signing always uses the current key; verify accepts the current key first,
  then each retired key, so outstanding checkpoints keep verifying. The old-key
  list is verify-only.
- The key is never logged, never sent to statelog, and neither signing nor
  verification is exposed to Agency code — the key is a host concern, and
  keeping it out of the language surface means untrusted agent code cannot mint
  MACs over attacker-chosen content.
- Subprocesses inherit the parent environment, so checkpoints created in a
  subprocess segment sign under the same key.

## What this is not

- **Not confidentiality.** The checkpoint is plaintext; the signature only
  detects modification.
- **Not freshness or binding.** An old, genuinely-signed checkpoint verifies
  (replay), and a signed checkpoint from one program verifies when posted to
  another program sharing the key. Binding a checkpoint to its invocation or
  interrupt id is the host's job.
- **Not a boundary against in-process code.** The key lives in the same
  process as running agent code; HMAC defends the round trip to an external
  caller, not against code already running where the key is.
- **Verifiable only where the key is.** HMAC is symmetric: every verifier can
  also sign. That fits the deployment shape here (a host verifying checkpoints
  it handed out).

## Performance

Signing costs one extra canonicalize + stringify + HMAC over the whole
checkpoint at creation. For interrupt checkpoints that is noise. The known hot
path is trace mode with a key set (a checkpoint per step over state that
includes full thread history); trace already stringifies every checkpoint to
disk, so signing roughly doubles that per-step serialization. If it ever shows
up in a profile, the escape hatch is skipping signing for trace-store
checkpoints — they never leave the machine.
