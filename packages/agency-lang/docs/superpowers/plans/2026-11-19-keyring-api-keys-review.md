# Review: API Keys in the Keychain

Plan: `2026-11-19-keyring-api-keys.md`, beside this file.

## Verdict

The plan has the right shape: the keyring fixes go in the keyring module, keys become environment variables at startup, and nothing downstream changes. Fix three things before you build it:

1. Step 4's round-trip test fails as written, because `find-generic-password -w` prints non-ASCII values as hex (Must fix 1).
2. Agent startup gets ~240 ms slower for the most common user, the one with a single key in their environment (Must fix 2).
3. The existing agent-action tests would read the developer's real login keychain (Must fix 3).

Everything else is small.

## What I ran

On this Mac, with a throwaway keychain in a scratch folder that I deleted afterwards. `security create-keychain` doesn't add the file to the search list, so the login keychain's search list stayed the same.

| Check                                                | Result                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `security -i` with quoted flags (`"-U"`, `"-s"`)     | **Works.** That answers the plan's open question, so Step 1's expected string can stay. |
| `-U` on an existing item                             | Replaces the password in place.                                                        |
| A failing command inside `security -i`               | Exit 44. stderr ends with `find-generic-password: returned -25300`.                    |
| A value that starts with `-`                         | Stored and read back correctly.                                                        |
| Step 4's value, `it's a "key" \ with $HOME and ünïcode` | **Fails:** it reads back as `69742773…636f6465`, which is hex.                           |
| Time for one lookup of a missing item                | ~30 ms (`/usr/bin/time`, 3 runs).                                                      |

I didn't test a locked keychain or an item that doesn't trust `security`. Either one would open a dialog on your screen.

## Must fix

### 1. `-w` prints non-ASCII values as hex, so Step 4 fails

`find-generic-password -w` prints the password as hex whenever it has a byte that isn't printable ASCII. How the item was stored doesn't matter:

```
stored value                     -w prints
it's a "key" \ with $HOME        it's a "key" \ with $HOME    ✓
ünïcode                          c3bc6ec3af636f6465           ✗ hex
a<TAB>b                          610962                       ✗ hex
616263                           616263                       (the literal value)
```

The last two rows show the real problem. From `-w` alone you can't tell whether `616263` is the stored value or `abc` encoded as hex. API keys are printable ASCII, so the feature itself works. But `std::auth/keyring`'s `getSecret` silently gives a stdlib user hex for any accented or non-Latin secret.

The Facts bullet about `-X` gives the wrong reason. Hex comes from the read, not from `-X`.

**Fix: read with `-g` instead of `-w`.** `-g` puts the password on stderr in a form you can parse without guessing:

```
password: "616263"
password: 0x69742773206120226B657922205C20776974682024484F4D45  "it's a \"key\" \134 with $HOME"
password: 0xC3BC6EC3AF636F6465  "\303\274n\303\257code"
```

Anything with a quote, a backslash or a non-printable byte gets the `0x` form, so the plain form never contains a `"`. Parsing it is short:

```ts
/** The password from `security find-generic-password -g`'s stderr. */
export function passwordFromSecurityOutput(stderr: string): string | null {
  const line = stderr.split("\n").find((l) => l.startsWith("password: "));
  if (line === undefined) return null;
  const hex = /^password: 0x([0-9A-F]+)/.exec(line);
  if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
  const plain = /^password: "(.*)"$/.exec(line);
  return plain ? plain[1] : null;
}
```

`readSecret` is being rewritten anyway, so this costs one function and a few unit tests: the four rows above, using the stderr lines shown. In Step 4, read back with `-g` and this function instead of `-w`, and keep `ünïcode` in the value. Then the test covers what a user actually gets back. Linux is unaffected: `secret-tool lookup` prints raw bytes.

If you'd rather not change the read, the fallback is: make Step 4's value printable ASCII, and say in `getSecret`'s docstring that on macOS a value outside printable ASCII comes back hex-encoded.

### 2. Startup cost: the person with a key already set pays the most

The architecture review says "someone with their key in the environment pays nothing." That's wrong. `loadApiKeys` skips only the variables that are already set. Someone with just `ANTHROPIC_API_KEY` in `.zshrc`, the common case, still looks up the other eight, one after another. At ~30 ms each, that's ~240 ms on every `agency agent` start, `agency agent --help` included.

**Fix: run the first lookup alone, then the rest at the same time.** The first lookup hits a locked keychain or a missing command, if there is one. So "at most one prompt for a locked keychain" still holds, and the total drops to about two lookups' worth of time:

```ts
const [first, ...rest] = unset;
const firstResult = await readSecret(host, first, API_KEY_SERVICE, timeoutMs);
if (firstResult.kind === "failed") return { loaded: [], failed: firstResult.reason };
if (firstResult.kind === "unavailable") return { loaded: [], failed: null };
const restResults = await Promise.all(
  rest.map((variable) => readSecret(host, variable, API_KEY_SERVICE, timeoutMs)),
);
// then set every `found` in table order, and report the first `failed`
```

One trade-off: items that don't trust `security` would each show a dialog at once. Fix 6 steers people away from creating those. Add one test: when the first lookup is `missing`, every other unset variable is read.

### 3. Existing tests would read the developer's login keychain

`scripts/agency.test.ts:425–448` ("agent action provenance") injects only `launchAgent`. Once the action calls `deps.loadApiKeys ?? loadApiKeys`, those tests run the real `loadApiKeys`. That spawns the real `security` against the login keychain and copies any keys it finds into the test process's `process.env`. It breaks the plan's own rule, "Tests never touch the login keychain." If the developer's keychain is locked, it can also open a dialog.

Either add those tests to Task 2's Files list and give each one a stub `loadApiKeys`, or take fix 4, which avoids the problem.

## Should fix

### 4. `doctor`, `review` and `policy` start the agent too

`runBundledAgent` is also called from `lib/cli/doctor.ts:64`, `lib/cli/review.ts:6` and `lib/cli/policy.ts:92`. They need a model key as much as `agency agent` does. With the plan as written, a key in the keychain works for `agency agent`, but `agency doctor` finds no key.

**Suggest:** call `loadApiKeys` inside `runBundledAgent`, just before `withRootCarriers(process.env, …)` (`lib/cli/runBundledAgent.ts:266`). That's one call site covering all four commands, and `agency run` still never pays for it. `runBundledAgent` already has an injectable launcher type (line 124), so the stub goes there, not in `CliDependencies`. The existing action tests replace `launchAgent` completely, so they never reach the lookup, which also fixes 3. The catch: `runBundledAgent` is synchronous today (line 197), so it becomes `async`, and its four callers need to `await` it or explicitly drop the promise.

If you'd rather keep it to `agency agent`, say in the docs that `doctor`, `review` and `policy` don't read the keychain.

### 5. OAuth encryption still throws away its key when a read fails

`lib/stdlib/oauthEncryption.ts:22–37` handles a null from `getSecret` by making a new key and saving it over the old one. If the read failed (an unlock prompt that was cancelled, a timeout), the saved key gets replaced, and every saved OAuth token can no longer be decrypted. This bug predates the plan, but the plan builds the exact tool that fixes it:

```ts
const lookup = await readSecret(host, KEYRING_KEY);
if (lookup.kind === "failed") throw new Error(`Couldn't read the OAuth key from the keyring: ${lookup.reason}`);
if (lookup.kind === "found") { /* as today */ }
// generate a new key only for "missing"
```

That's about five lines and one test. Include it in Task 1, or name it in the PR description as a known follow-up. The plan's "oauthEncryption.ts is unchanged" shouldn't stand without comment.

### 6. Tell people to create the item with `security`, not Keychain Access

An item created in Keychain Access, or by any other app, doesn't list `/usr/bin/security` as trusted. Every lookup then opens a "security wants to use your confidential information" dialog. With a 2 s timeout nobody can answer it in time, and stopping at the first failure means that one item blocks every key after it. In `models.md`, say "create it with this command", not just "it can live in the keyring".

Add to Step 6: create an item in Keychain Access, start the agent, and watch the dialog. Does it close when the child is killed at 2 s, or does it stay open with no one waiting for the answer? Write down what happens in the dev doc.

## Minor

- **Wrong error for a missing `secret-tool`.** `_getSecret` throws "today's message" for `unavailable`. On Linux with no `secret-tool` that message reads "System keyring is not supported on linux", which is wrong. Say `secret-tool isn't installed`.
- **"Timed out" can't happen in Agency.** The Agency-facing `getSecret` passes no timeout, so its new docstring ("locked, refused, or timed out") describes a timeout that can't happen. A locked keychain waits on the prompt instead. Drop "timed out", or pass a timeout through.
- **Fix the Facts bullet about `-X`** to say what fix 1 found: `-w` output is hex for any value that isn't printable ASCII.
- **Linux without a Secret Service.** If `secret-tool` is installed but there's no D-Bus session (CI, SSH), the first lookup can hang until the 2 s timeout on every start. One possible check: on Linux, skip the lookup when `DBUS_SESSION_BUS_ADDRESS` is unset. It's worth one line in the dev doc even if you don't do it.

## Part B (Perry)

The decisions look right. Saving through the engine, so that the item trusts `security`, is the key point, and fix 6 shows why. One addition: the new `POST /settings/app/api-key` route's body must never reach Perry's or the engine's logs. Say so in Part B's plan, and add a test that the key doesn't show up in the log after a save.

## How the plan took this review

Every point is applied in the plan.

- **1:** reads use `-g`, with `passwordFromSecurityOutput` and its four rows as tests. The round-trip test reads back with `-g` and keeps `ünïcode`. The Facts bullet about `-X` is replaced.
- **2:** the first lookup runs alone, then the rest at the same time, with a test that they all start.
- **3 and 4:** loading moved into `runBundledAgent`, which becomes `async`, so `doctor`, `review` and `policy` get keys too. Every `runBundledAgent` test that reaches the launch gets a stub `loadApiKeys`.
- **5:** the OAuth fix is in Task 1, with a test.
- **6:** the docs say to create the item with `security`, and Step 6 checks the Keychain Access dialog.
- **Minors:**
  - `unavailable` carries its own reason ("`secret-tool` isn't installed").
  - The docstring no longer mentions a timeout.
  - On Linux and WSL, loading skips the keyring when `DBUS_SESSION_BUS_ADDRESS` is unset.
  - The warning appears only when there's then no key at all (`keychainWarning`).
- **Part B:** the route's body never reaches a log, with a test.
