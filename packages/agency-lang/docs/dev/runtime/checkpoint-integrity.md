# Checkpoint integrity checksums

On the external resume path (HTTP `/resume`, a checkpoint loaded from disk), a
checkpoint comes back from a caller who could have edited it. When a signing
key is configured, every checkpoint carries an HMAC checksum of its own
contents in a `signature` field, and a host can check it with one call before
resuming:

```ts
import { verifyCheckpointChecksum } from "agency-lang";

if (!verifyCheckpointChecksum(checkpoint)) {
  // refuse the resume — the checkpoint is not the one this host handed out
}
```

`verifyCheckpointChecksum` returns true only when the checkpoint carries a
signature that validates under the configured key, compared in constant time.
A missing signature returns false, so a caller cannot dodge verification by
stripping the field.

## Where verification is enforced

Checkpoint creation signs but does not refuse: editing checkpoints is a
supported feature, and trace mode writes a checkpoint per step. External hosts
still choose whether to call `verifyCheckpointChecksum`.

The `agency resume` command verifies any checkpoint that carries a signature.
It first validates the checkpoint shape, then checks the signature with the
configured current and retired keys. It refuses a signature it cannot verify;
`--force` bypasses that refusal. Unsigned checkpoints remain editable and can
be resumed without a key.

## Signing

`Checkpoint.fromStateStack` is the single chokepoint every checkpoint is
created through, and its last statement calls `signCheckpoint`. With no key in
the environment that call is a no-op; with a key, every checkpoint comes out
signed. The legitimate edit paths — resume-time overrides,
`CheckpointStore.pin`, and `Checkpoint.clone` — re-sign, so an edited
checkpoint stays self-consistent. Both functions also accept the plain parsed
JSON form of a checkpoint, which is what the external resume path carries.

## What is signed

HMAC-SHA256, hex-encoded, over:

```
"agency.checkpoint.v1" + "\n" + canonicalize(toJSON() minus the signature field)
```

`canonicalize` (`lib/utils/canonicalize.ts`) key-sorts objects at every depth,
so a checkpoint that was stored, parsed, and re-serialized with different key
order hashes identically. The checksum covers the whole checkpoint, so new
fields are covered automatically. There is no algorithm field; the algorithm
is fixed in code, and the domain tag changes if it ever does.

`Checkpoint.fromJSON` validates the checkpoint with the zod schemas before
verification recomputes the canonical form. A `toJSON` field missing from its
schema makes a valid checkpoint verify false. Every new field on a checkpoint
tree must appear in the schema in the same change.

## The key

- `AGENCY_CHECKPOINT_KEY`, at least 32 bytes (`openssl rand -hex 32`). A
  short key throws `CheckpointKeyTooShortError`; an unset key means signing
  is off.
- Rotation: move the retiring key into `AGENCY_CHECKPOINT_KEY_OLD`
  (comma-separated, verify-only) and put the new key in
  `AGENCY_CHECKPOINT_KEY`; outstanding checkpoints keep verifying.
- The key is never logged or sent to statelog, and neither signing nor
  verification is exposed to Agency code. Subprocesses inherit the parent
  environment and sign under the same key.

## What this is not

- **Not confidentiality**: the checkpoint is plaintext.
- **Not freshness or binding**: an old signed checkpoint verifies (replay),
  and one program's checkpoint verifies against another sharing the key.
  Binding to an invocation or interrupt id is the host's job.
- **Not a boundary against in-process code**: the key lives in the process
  that runs agent code; the checksum defends the round trip to an external
  caller.
- **Verifiable only where the key is**: HMAC is symmetric, so every verifier
  can also sign.

Signing costs one canonicalize + HMAC per checkpoint creation, only when a
key is set. The known hot path is trace mode (a checkpoint per step); if that
ever shows in a profile, skip signing for trace-store checkpoints — they
never leave the machine.
