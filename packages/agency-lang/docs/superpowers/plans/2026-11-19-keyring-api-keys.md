# API Keys in the Keychain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A model API key saved in the system keyring works for `agency agent` (and Perry, once it uses the helpers this adds), and `std::auth/keyring` stores and reads secrets safely.

**Architecture:** One agency-lang PR.

- **Task 1** fixes the keyring module (`lib/stdlib/keyring.ts`), and the OAuth key handling that depends on it.
- **Task 2** adds `lib/stdlib/apiKeys.ts`: at startup, each provider variable that isn't set is read from the keyring into the environment. `runBundledAgent`, which starts the agent for `agency agent`, `doctor`, `review` and `policy`, calls it before it launches.

Part B, in Perry, follows once a release has this.

**Tech Stack:** TypeScript, vitest, macOS `security`, Linux `secret-tool`.

**Reviews:** `2026-11-19-keyring-api-keys-architecture-review.md` and `2026-11-19-keyring-api-keys-review.md`, beside this plan. Both are applied here.

**Spec:** None written. The requirements come from the conversation that asked for an API key field in Perry's onboarding. Perry's rules ("use Agency's own way", "Perry and the agency agent share one home") put key storage in agency-lang, so a key saved once serves both.

## What's wrong today

1. **agency-lang never reads model API keys from the keyring.** Keys come only from the environment, through the host's `settings.read` (`PROVIDER_KEY_VARIABLES` in `lib/runtime/llmClient.ts`).
2. **`setSecret` puts the secret on the command line.** On macOS it runs `security add-generic-password … -w <secret>`, so any user on the Mac can see it with `ps` while it runs.
3. **`getSecret` reads every failure as "no secret".** A locked keychain, a refused prompt and a timeout all return null. On macOS it also returns hex for any value that isn't printable ASCII, since it reads with `-w`.
4. **`setSecret` deletes, then adds.** If the add fails, the old secret is gone.
5. **OAuth encryption throws its key away when a read fails.** `oauthEncryption.ts` treats null as "no key", makes a new one, and saves it over the old, so every saved OAuth token can no longer be decrypted.

## Facts this plan relies on

These were checked on this Mac (Darwin 27), with throwaway keychains:

- **`security -i` reads commands from stdin,** one per line, and exits with the failing command's code.
  - Inside double quotes, `\"` is a quote and `\\` is a backslash. `$` and spaces are kept as they are. There is no single-quote quoting.
  - Quoted option flags (`"-U"`, `"-s"`) work.
  - A value that starts with `-` is stored correctly.
- **`add-generic-password -U` replaces** an existing item's password.
- **`find-generic-password` exits 44** when the item doesn't exist.
- **`find-generic-password -w` prints hex** for any password with a byte that isn't printable ASCII. Since a stored `616263` prints the same way, its output can't be decoded reliably.
- **`-g` puts the password on stderr** in one of two forms you can parse: `password: "plain"`, or `password: 0x<HEX>  "…"` whenever the value has a quote, a backslash or a byte that isn't printable. Use the hex.
- **Reading from a locked keychain doesn't fail.** It waits on a password prompt, so every lookup needs a timeout.
- **An item `security` didn't create** (made in Keychain Access, or by another app) doesn't trust `/usr/bin/security`, so every read of it opens a permission dialog.
- **One lookup of a missing item takes about 30 ms.**
- **`runProgram` throws `ProgramFailed`,** which carries `exitCode`, `stdout` and `stderr` (`lib/stdlib/abortable.ts`). A timeout throws it too.
- **`runBundledAgent` builds the child's environment from `process.env`** (`withRootCarriers(process.env, …)`, `lib/cli/runBundledAgent.ts:266`). It is called by `agent.ts`, `doctor.ts`, `review.ts` and `policy.ts`, and it is synchronous today.

## Global Constraints

- **A secret never appears in a process's arguments.** It travels on stdin only.
- **TypeScript `getSecret(host, …)` keeps its contract** for `github/credential.ts`: a string, null when nothing usable was found, and a throw on an unsupported system.
- **`oauthEncryption.ts` changes, on purpose:** a failed read throws, and only a missing key makes a new one.
- **The Agency-facing `getSecret` changes behavior:** it fails, where it used to return null, when the keyring couldn't be read. Say so in the docstring and the PR description.
- **Key names:** service `agency-lang`, account = the variable's name, such as `ANTHROPIC_API_KEY`. The variables are the values of `PROVIDER_KEY_VARIABLES`.
- **A key in the environment always wins.** The keyring is read only for variables that are unset or empty.
- **macOS and Linux only,** as the keyring module is today. Where there's no keyring, loading reads nothing and warns about nothing. That covers an unsupported system, a missing `security` or `secret-tool`, and Linux with no D-Bus session.
- **A key from the keychain is in the environment,** exactly like one set in `.zshrc`, so the agent's shell commands get it (`shellEnvironment` keeps API keys on purpose). The docs say so.
- **Only the commands that start the bundled agent load keys:** `agent`, `doctor`, `review` and `policy`, through `runBundledAgent`. `agency run` and the rest never pay for lookups.
- **Tests never touch the login keychain.**
  - Every test that reaches `runBundledAgent`'s launch injects a stub `loadApiKeys`.
  - The one test that runs the real `security` creates its own keychain file, deletes it afterwards, and never locks it, because a locked keychain would open a prompt on the person's screen.

## Review Focus

1. **A locked or refused keychain when the agent starts:** at most one prompt, startup carries on after the timeout, and a warning appears only when there's then no key at all. (Task 2: `"stops after a failed first lookup"`, `keychainWarning` tests.)
2. **Someone with one key in their environment, the common case:** startup costs about two lookups, not eight. (Task 2: `"after a missing first lookup, reads the rest at once"`.)
3. **A key in the environment wins over the keyring.** (Task 2: `"never reads a variable that is already set"`.)
4. **A secret with quotes, backslashes, `$`, spaces and non-ASCII letters round-trips exactly** through the real `security`. (Task 1: the macOS-only test.)
5. **No keyring is quiet:** no `secret-tool`, no D-Bus session, or an unsupported system. (Task 2.)

---

### Task 1: The keyring stores secrets on stdin, reads them exactly, and tells missing from failed

**Files:**

- Modify: `lib/stdlib/keyring.ts`, `stdlib/auth/keyring.agency` (the `getSecret` and `setSecret` docstrings), `lib/stdlib/oauthEncryption.ts`
- Test: `lib/stdlib/__tests__/keyring.test.ts`, `lib/stdlib/__tests__/oauthEncryption.test.ts`

**Interfaces:**

- Produces, in `lib/stdlib/keyring.ts`:
  - `export type SecretLookup = { kind: "found"; value: string } | { kind: "missing" } | { kind: "unavailable"; reason: string } | { kind: "failed"; reason: string }`.
    - `unavailable` means this system has no keyring the module supports (reason: today's "not supported" message), or its command isn't installed: the spawn fails with `ENOENT`, and the reason is "`security` isn't installed" or "`secret-tool` isn't installed".
  - `export async function readSecret(host: Host, key: string, service?: string, timeoutMs?: number): Promise<SecretLookup>`.
    - On macOS it runs `security find-generic-password -s <svc> -a <key> -g`, with no `-w`, and reads the password from stderr with `passwordFromSecurityOutput`. Output that function can't parse is `failed`.
    - On Linux it runs `secret-tool lookup …` as today.
  - `export function passwordFromSecurityOutput(stderr: string): string | null`. It reads the `password: ` line: the `0x<HEX>` form is decoded as UTF-8, and the plain `"…"` form is taken as it is. The second review's sketch is the algorithm.
  - `export function securityCommandLine(args: string[]): string`: each argument in double quotes, with `\` → `\\` and `"` → `\"`, joined by spaces. It throws `"Keyring values must be one line."` when an argument contains `\n`, `\r` or `\0`.
  - `getSecret(host, …)`: unchanged signature and contract. On an unsupported system it throws, as today. Otherwise it's `readSecret`, with null for `missing`, `unavailable` and `failed`.
  - `_getSecret(…)`: the value, or null for `missing`. It throws `Error(reason)` for `failed` and `unavailable`.
  - `setSecret(host, …)` on macOS: one run of `security` with args `["-i"]` and input `securityCommandLine(["add-generic-password", "-U", "-s", svc, "-a", key, "-w", value]) + "\n"`. No delete first. Linux is unchanged (`secret-tool store` already replaces, with the value on stdin).
- **Missing** means: on macOS, `ProgramFailed` with `exitCode === 44`. On Linux, `exitCode === 1` with empty stdout and stderr. Anything else thrown is `failed`, with the error's message as `reason`, and that includes a timeout.
- In `oauthEncryption.ts`, the key read uses `readSecret`:
  - `found`: as today.
  - `missing`: make and save a new key, as today.
  - `failed`: throw `Couldn't read the OAuth key from the keyring: <reason>`, and never save.
  - `unavailable`: as today's null path. With no keyring, nothing can be overwritten.

- [ ] **Step 1: Write the failing tests** in `keyring.test.ts`, replacing the two `_setSecret` macOS tests that expect a delete first:
  - `"stores the secret on stdin, never in the arguments"`: `_setSecret("my-key", "s3cr$t \"q\" \\b")`. Exactly one run. Its program is `security` and its args are `["-i"]`. `mockRun.mock.calls[0][1].input` equals `'"add-generic-password" "-U" "-s" "agency-lang" "-a" "my-key" "-w" "s3cr$t \\"q\\" \\\\b"\n'`. No argument contains `s3cr`.
  - `"updates in place, with no delete first"`: no run's args contain `delete-generic-password`.
  - `"refuses a value with a line break"`: `_setSecret("k", "a\nb")` rejects with `"must be one line"`, and `mockRun` was never called.
  - `"a failed store throws"`: `mockRun` resolves `failed("add-generic-password: returned 2", 2)`, and `_setSecret` rejects.
  - `passwordFromSecurityOutput`, one test per row:

    | stderr line | result |
    | --- | --- |
    | `password: "616263"` | `"616263"` |
    | `password: 0x69742773206120226B657922205C20776974682024484F4D45  "it's a \"key\" \134 with $HOME"` | `it's a "key" \ with $HOME` |
    | `password: 0xC3BC6EC3AF636F6465  "\303\274n\303\257code"` | `"ünïcode"` |
    | no `password: ` line | `null` |

  - `readSecret` on macOS:
    - exit 44 → `{ kind: "missing" }`;
    - exit 0 with stderr `password: "v"\n` → `{ kind: "found", value: "v" }`, and the args contain `-g` and not `-w`;
    - `failed("User interaction is not allowed.", 51)` → `kind: "failed"`, with a `reason` containing `51`;
    - `"a timeout is a failure"`: a result with `timedOut: true` → `kind: "failed"`;
    - exit 0 with no `password: ` line → `kind: "failed"`.
  - `readSecret` on Linux (`testPlatform.os = "linux"`):
    - exit 1 with empty output → `missing`;
    - exit 1 with stderr `"No such interface"` → `failed`;
    - a spawn rejected with an `ENOENT` error → `unavailable`, with a reason that says `secret-tool` isn't installed.
  - `readSecret` on a system the keyring doesn't support → `unavailable`, with no run.
  - `"getSecret keeps returning null when the keyring can't be read"`: a failed lookup gives null from `getSecret(host, …)`.
  - `"_getSecret fails when the keyring can't be read"`: the same lookup makes `_getSecret` reject.
  - `securityCommandLine`: `["a b", "x\"y", "c\\d", "$HOME"]` → `'"a b" "x\\"y" "c\\\\d" "$HOME"'`.

  In `oauthEncryption.test.ts`, `"a failed read throws and never replaces the key"`: the read fails (exit 51). Getting the key rejects with `"Couldn't read the OAuth key"`, and no run stores anything.

- [ ] **Step 2: Run them to see them fail.** `pnpm vitest run lib/stdlib/__tests__/keyring.test.ts lib/stdlib/__tests__/oauthEncryption.test.ts`. Expected: they fail, because `readSecret`, `passwordFromSecurityOutput` and `securityCommandLine` don't exist, `_setSecret` still deletes first, and OAuth overwrites on a failed read.

- [ ] **Step 3: Implement** the Interfaces above.
  - Update the docstrings in `stdlib/auth/keyring.agency`:
    - `getSecret` "fails when the keyring couldn't be read, for example when it's locked or access was refused";
    - `setSecret` "replaces any existing value in place".
  - Regenerate the stdlib docs with the repo's `agency doc` script, as `CLAUDE.md` says, rather than editing `docs/site/stdlib/auth/keyring.md` by hand.

- [ ] **Step 4: Add the macOS-only round-trip test**, `"security stores and returns exactly the value securityCommandLine quotes"`, using `it.runIf(process.platform === "darwin")`:
  1. `security create-keychain -p test <tmp>/t.keychain-db`, then `security unlock-keychain -p test <file>`.
  2. Pipe `securityCommandLine(["add-generic-password", "-U", "-s", "agency-lang-test", "-a", "k", "-w", value, file]) + "\n"` into `security -i`.
  3. Read it back with `security find-generic-password -s agency-lang-test -a k -g <file>`, and expect `passwordFromSecurityOutput(stderr)` to be exactly `value`.
  4. Run that for `value` = `it's a "key" \ with $HOME and ünïcode`, and for `-starts-with-a-dash`.
  5. In `finally`, run `security delete-keychain <file>`. Never lock it.

- [ ] **Step 5: Run the tests.** `pnpm vitest run lib/stdlib/__tests__/keyring.test.ts lib/stdlib/__tests__/oauthEncryption.test.ts lib/stdlib/github/credential.test.ts`. Expected: PASS. The last file shows the GitHub credential is unchanged.

- [ ] **Step 6: Commit.** `git commit -m "keyring: store secrets on stdin, read them exactly, tell missing from failed"`

### Task 2: Provider keys from the keyring, for every command that starts the agent

**Files:**

- Create: `lib/stdlib/apiKeys.ts`
- Test: `lib/stdlib/__tests__/apiKeys.test.ts`
- Modify: `lib/cli/runBundledAgent.ts` (it becomes `async` and loads keys), its callers `lib/cli/agent.ts`, `doctor.ts`, `review.ts` and `policy.ts`, and their actions in `scripts/agency.ts`, which `await` them
- Test: `lib/cli/runBundledAgent.orchestration.test.ts`, `lib/cli/runBundledAgent.test.ts`
- Modify: `docs/site/agent/models.md` (the first paragraph), `docs/dev/agents/agent-presets.md` (a short section)

**Interfaces:**

- Consumes: `readSecret`, `setSecret` (Task 1), `PROVIDER_KEY_VARIABLES` (`lib/runtime/llmClient.ts`), and the host's `env` (`HostEnv`: `get`, `set`, in `lib/host/host.ts`).
- Produces, in `lib/stdlib/apiKeys.ts`, which Perry imports as `agency-lang/stdlib-lib/apiKeys.js`:
  - `export const API_KEY_SERVICE = "agency-lang"`
  - `export function apiKeyVariables(): string[]`: the values of `PROVIDER_KEY_VARIABLES`, in table order.
  - `export type LoadedApiKeys = { loaded: string[]; failed: string | null }`
  - `export async function loadApiKeys(args: { host: Host; timeoutMs?: number }): Promise<LoadedApiKeys>`:
    - The variables to read are those in `apiKeyVariables()` that `host.env.get` gives no non-empty value. With none, it returns at once.
    - On Linux and WSL, when `host.env.get("DBUS_SESSION_BUS_ADDRESS")` is empty, there's no Secret Service to ask. It returns `{ loaded: [], failed: null }` and runs nothing.
    - It reads the **first** variable alone. `failed`: it returns `{ loaded: [], failed: reason }`, so a locked keychain asks at most once. `unavailable`: it returns `{ loaded: [], failed: null }`, quietly.
    - Otherwise it reads **the rest at the same time**, then calls `host.env.set` for every `found`, in table order. `failed` is the first `failed` reason in table order, or null.
    - `timeoutMs` defaults to 2000.
  - `export function keychainWarning(args: { result: LoadedApiKeys; env: HostEnv }): string | null`: `Couldn't read API keys from the keychain: <reason>` when `result.failed` is set and no variable in `apiKeyVariables()` has a value in `env`. Otherwise null. The warning only matters when the agent will find no key.
  - `export async function saveApiKey(args: { host: Host; variable: string; value: string }): Promise<void>`: throws `"Not an API key variable: X"` unless `variable` is in `apiKeyVariables()`. Then it calls `setSecret(host, variable, value, API_KEY_SERVICE)`.
- In `lib/cli/runBundledAgent.ts`:
  - `RunBundledAgentDependencies` gains `loadApiKeys: typeof loadApiKeys`, defaulting to the real one.
  - `runBundledAgent` returns `Promise<void>`. Just before `withRootCarriers(process.env, …)`, it runs `const result = await launcher.loadApiKeys({ host: currentHost() })`, and prints `keychainWarning({ result, env: currentHost().env })` with `console.error` when it isn't null. It always goes on to launch.
  - `agent`, `doctor`, `review` and `policyGen` return its promise, and their actions in `scripts/agency.ts` `await` them. The program already runs `parseAsync`.

- [ ] **Step 1: Write the failing tests.** In `apiKeys.test.ts`, with the fake subprocess from `fakeSubprocess.ts`. The host is `{ ...hostOn("macos"), env }`, where `env` is a `HostEnv` over a plain object, so no test touches `process.env`:
  - `"loads a key that isn't in the environment"`: the lookup for `ANTHROPIC_API_KEY` exits 0 with stderr `password: "sk-1"` and every other exits 44. Then `env.get("ANTHROPIC_API_KEY") === "sk-1"`, and `loaded` is `["ANTHROPIC_API_KEY"]`.
  - `"never reads a variable that is already set"`: with `OPENAI_API_KEY` set to `"mine"`, no run's args contain `OPENAI_API_KEY`, and the value is still `"mine"`.
  - `"after a missing first lookup, reads the rest at once"`: with only `ANTHROPIC_API_KEY` set, the first lookup exits 44. Then every other unset variable is read, one run each, and the rest start before any of them finishes. Make the fake hold its answers until all have started.
  - `"stops after a failed first lookup"`: the first lookup times out. Exactly one run happens, `failed` contains the reason, and `loaded` is `[]`.
  - `"reads nothing where there is no keyring"`: with the host's system set to one the keyring doesn't support (any value of `OperatingSystem` other than `macos`, `linux` and `wsl`), no runs happen, and the result is `{ loaded: [], failed: null }`.
  - `"is quiet where the keyring command isn't installed"`: on Linux with `DBUS_SESSION_BUS_ADDRESS` set, the first spawn rejects with `ENOENT`. Exactly one run happens, and the result is `{ loaded: [], failed: null }`.
  - `"reads nothing on Linux with no D-Bus session"`: on Linux with `DBUS_SESSION_BUS_ADDRESS` unset, no runs happen.
  - `keychainWarning`:
    - `failed: "locked"` with no key in `env` → the warning;
    - `failed: "locked"` with `ANTHROPIC_API_KEY` set → null;
    - `failed: null` → null.
  - `"saveApiKey refuses a name that isn't a provider variable"`: `saveApiKey({…, variable: "PATH", …})` rejects, and no runs happen.
  - `"saveApiKey stores under agency-lang and the variable's name"`: the stdin of the single run contains `"-s" "agency-lang" "-a" "ANTHROPIC_API_KEY"`.

  In `runBundledAgent.orchestration.test.ts`:
  - `"loads keys from the keychain before it spawns"`: inject a `loadApiKeys` and a `spawn` that record the order, and expect `["load", "spawn"]`.
  - `"launches even when the keychain can't be read"`: a `loadApiKeys` returning `{ loaded: [], failed: "locked" }`, and `spawn` is still called.

  In both `runBundledAgent` test files, give every call that reaches the launch a stub, `loadApiKeys: async () => ({ loaded: [], failed: null })`. Add it to the file's shared dependencies if it has them, and to each call otherwise, so no test reads the developer's keychain.

- [ ] **Step 2: Run them to see them fail.** `pnpm vitest run lib/stdlib/__tests__/apiKeys.test.ts lib/cli/runBundledAgent.orchestration.test.ts lib/cli/runBundledAgent.test.ts`. Expected: the new tests fail, because `apiKeys.ts` doesn't exist and `runBundledAgent` doesn't load keys.

- [ ] **Step 3: Implement** `apiKeys.ts`, and the changes to `runBundledAgent` and its callers, as in the Interfaces above.

- [ ] **Step 4: Document it.** In `docs/site/agent/models.md`:
  - Change `GOOGLE_API_KEY` in the first sentence to `GEMINI_API_KEY`, the variable the code reads.
  - Add that a key can also live in the system keyring, under service `agency-lang`, with the variable's name as the account. Say to **create it with this command**, which asks for the key so it never appears in `ps`:

    ```bash
    security add-generic-password -s agency-lang -a ANTHROPIC_API_KEY -w
    ```

    An item made in Keychain Access doesn't trust `security`, so each start opens a dialog that times out, and the key isn't read.
  - Say that a key in the environment wins, and that a key from the keychain is in the agent's environment, like one from `.zshrc`, so its shell commands can see it.

  In `docs/dev/agents/agent-presets.md`, which already covers how the agent finds providers by their keys, add a short section, "Keys from the keychain". Cover:
  - what `loadApiKeys` reads, and that `runBundledAgent` calls it, for `agent`, `doctor`, `review` and `policy`;
  - the first lookup alone, then the rest at once, and why;
  - that no keyring, no `secret-tool` and no D-Bus session are all quiet;
  - when the warning appears;
  - what Step 6 found about the Keychain Access dialog.

- [ ] **Step 5: Run the checks.** The test command from Step 2, plus `pnpm vitest run scripts/agency.test.ts`, then `pnpm run lint` and `pnpm run fmt:ts`. Expected: PASS.

- [ ] **Step 6: Check by hand on macOS.**
  1. Run `env -u ANTHROPIC_API_KEY agency agent` with no key in the keyring. It behaves as today: no key found.
  2. Save a key with the command in Step 4, then run `env -u ANTHROPIC_API_KEY agency agent`. The agent finds Anthropic, and a turn works.
  3. Delete it with `security delete-generic-password -s agency-lang -a ANTHROPIC_API_KEY`.
  4. Create the same item in Keychain Access instead, and run the command from step 2 again. Watch the "security wants to use your confidential information" dialog. Does it close when the lookup is stopped at 2 s, or stay open with no one waiting for the answer? Write down which in the dev doc, then delete the item.

- [ ] **Step 7: Commit and open the PR.**
  - `git commit -m "The agent reads model API keys from the system keyring"`.
  - In the PR description, name the behavior change to the Agency-facing `getSecret`, and the OAuth fix.

---

## Part B (Perry, after an agency-lang release with this)

A separate PR, with its own plan when it starts. The decisions so far:

- **The engine loads keys at startup.** `src/engine/main.ts` awaits `loadApiKeys({ host })` before `createEngine`. `providerKeys(env)` and every session then see them, and onboarding lists a keyring key as found.
- **The key field saves through the engine, never from Swift.** An item created by `security` lets `security` read it without asking. If Swift saved the key with Apple's Keychain calls, every read by the engine would open a permission dialog (see Facts).
  - A new route, `POST /settings/app/api-key { provider, key }`, calls `saveApiKey` and sets the variable through the host's `env`, so no restart is needed.
  - The key goes from the app to the engine over the existing loopback connection, with the token. The engine never sends a key back: `/settings/app` still reports only whether each variable is set.
  - **The route's body never reaches a log,** Perry's or the engine's. A test saves a key and checks that it isn't in the log.
- **Onboarding's "no keys" screen gets a secure text field** for the chosen provider. Settings gets "Change key…" for the default provider.
- **`PROTOCOL_VERSION` goes up**, since there's a new route.
