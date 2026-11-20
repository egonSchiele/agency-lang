# Architecture review: API Keys in the Keychain

Plan: `docs/superpowers/plans/2026-11-19-keyring-api-keys.md`

## Summary

The plan is the right size, and its pieces are in the right places: the fixes are in the keyring module, and loading is in the one command that needs it. Five changes, all now applied to the plan:

1. **Use the host's `env`, not a raw object.** The host already has `env.get` and `env.set` (`HostEnv`, `lib/host/host.ts`). `loadApiKeys` should read and write through them, so it works on any host and its tests need no `process.env` cleanup.
2. **Don't warn when there is no keyring to read.** On Linux without `secret-tool`, or over SSH with no Secret Service, every lookup fails. As planned, every `agency agent` start there would print a warning. Treat "the keyring command isn't installed" as no keyring, and print the warning only when the agent then has no key at all, which is when it explains something.
3. **Say plainly that a key from the keychain is in the environment.** The agent's shell commands get the whole environment (`shellEnvironment`, `lib/host/node/nodeSubprocess.ts`), so a keychain key reaches them exactly as a key from `.zshrc` does today. Keeping keychain keys out of `process.env` would mean changing how `env()` reads for every program, since the agent checks for keys with `env(varName) with approve` (`models.agency`). That's far more than this is worth. Document it instead.
4. **Fix the doc paragraph the plan already edits.** `docs/site/agent/models.md` says `GOOGLE_API_KEY`, but the code reads `GEMINI_API_KEY` (`envVarFor` in `stdlib/llm.agency`, `PROVIDER_KEY_VARIABLES`).
5. **A smaller dev doc.** A few lines in a section are enough for ~60 lines of code. A new file isn't needed unless a dev doc for the agent's models is the natural home, so use that home if it exists.

## 1. Major features and the public API

- **`std::auth/keyring` is public stdlib.** The plan changes the Agency-facing `getSecret`: a keyring that can't be read now fails, where it used to return null. No Agency code on `main` calls it except the module itself, so the change breaks nothing in the repo. It is still a behavior change for users, and the plan already names it for the PR description and the changelog.
- **`agency agent` is one of the most used commands.** The change adds keyring lookups before launch, but only for variables that aren't set. Someone with their key in the environment pays nothing. Someone with no keys pays about nine fast `security` runs, which happen one at a time and stop at the first failure.
- **The TypeScript `getSecret(host, …)` keeps its contract.** OAuth encryption and GitHub credentials are unchanged.

## 2. Effort and impact

| Task                                         | Effort                   | Impact                                                    | Verdict                                                              |
| -------------------------------------------- | ------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------- |
| Secret on stdin (`security -i`)              | Small                    | **High:** a security fix for every `setSecret` user       | Must do.                                                             |
| Update in place                              | Tiny                     | Medium: a failed save no longer loses the key             | Must do. It comes free with the stdin change.                        |
| `readSecret`: missing vs failed              | Small                    | Medium: Perry stops saying "no key" to someone who has one | Do. `loadApiKeys` needs it to stop at the first failure.             |
| Agency-facing `getSecret` fails on a failure | Tiny                     | Low today: no callers                                     | Optional, but cheap and correct. Keep.                               |
| `loadApiKeys` + the `agent` action           | Small–medium             | **High:** the point of the PR                             | Must do.                                                             |
| Real-`security` quoting test                 | Small                    | High: quoting is the one thing mocks can't prove          | Keep. It's macOS-only, and fast.                                     |
| New dev doc file                             | Small                    | Low                                                       | Shrink to a short section (Summary 5).                               |

Nothing is optional, low-impact and high-effort.

## 3. The 80/20 rule

The goal: a key typed into Perry also works in `agency agent`, and saving it is safe.

- **The keychain is just another place environment variables come from.** That's the 80/20, and the plan already does it: fill in unset variables at startup, and everything downstream (`withHostKeys`, `env()` in the agent, Perry's `providerKeys`) works unchanged. A per-call keyring lookup would need the synchronous `settings.read` to become async across the runtime.
- **No `agency keys set` command now.** Perry is the way to enter a key, and the docs give the one-line `security` command for the terminal. If a command is wanted later, reuse `lib/cli/remote/secretsInput.ts`. It already reads a secret from a hidden prompt, stdin or `--from-env`, never from argv, for `agency secrets set`.
- **One keyring item per variable,** not one item holding every key as JSON. One item would mean one lookup, but it would also mean a read-modify-write race when Perry and the terminal save different keys. With the lookups stopping at the first failure, one item per variable costs at most one prompt anyway.

## 4. What already exists

| Existing thing                                      | Path                                    | Could it do the job?                                                                                                                                                                                     |
| --------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub token lookup: environment, `gh`, then keyring | `lib/stdlib/github/credential.ts`       | It's the same pattern, for one token, read when it's needed. The plan follows it: environment first, then service `agency-lang`. It can't be reused directly, because model keys are read synchronously. |
| `PROVIDER_KEY_VARIABLES`                            | `lib/runtime/llmClient.ts`              | **Yes.** The plan uses it as the list of variables.                                                                                                                                                      |
| `envVarFor` (provider → variable)                   | `stdlib/llm.agency`                     | A second copy of the same names, by provider. They agree. Leave it, and don't add a third.                                                                                                               |
| `HostEnv` (`env.get`, `env.set`)                    | `lib/host/host.ts`                      | **Yes.** `loadApiKeys` should use it rather than take a raw object (Summary 1).                                                                                                                          |
| `ProgramFailed` (exit code, stdout, stderr)         | `lib/stdlib/abortable.ts`               | **Yes.** `readSecret` reads the exit code from it.                                                                                                                                                       |
| `secretsInput.ts` (hidden prompt, never argv)       | `lib/cli/remote/secretsInput.ts`        | Not needed now. It's the piece to reuse for a future `agency keys set` (§3).                                                                                                                             |
| `isKeyringAvailable`                                | `lib/stdlib/keyring.ts`                 | Partly. It tells "no keyring command" from a failure, which Summary 2 needs, but it costs a run of its own. Treating a missing command (`ENOENT`) as no keyring does the same for free.                    |
| `shellEnvironment`, which drops some variables      | `lib/host/node/nodeSubprocess.ts`       | It keeps API keys on purpose ("a person sets GH_TOKEN and GITHUB_TOKEN on purpose"). That's why a keychain key reaches the agent's commands (Summary 3).                                                   |

## 5. Where each change goes

- **The keyring fixes are in the keyring module,** and every caller gets them: Agency's `setSecret`, OAuth encryption, GitHub credentials.
- **Loading is called from the two programs that need it,** the `agent` command and, later, Perry's engine. It isn't in the node host's start-up or in `agency run`, so no other program pays for keyring lookups. That's right: "fill in API keys from the keychain" is a choice an app makes, not something every Agency program should do.
- **Nothing checks one caller's name.** `saveApiKey` accepts only names in `PROVIDER_KEY_VARIABLES`, which is a general rule, not a special case.

## 6. Core features

- **Interrupts:** the Agency-facing keyring functions keep their effects (`std::setSecret`, `std::getSecret`). `loadApiKeys` calls the TypeScript functions with no interrupt, as the GitHub credential does. That's right for host code that runs before any agent code, the same way the environment is read without asking. Once loaded, the agent reads the key through `env(…) with approve`, as it does today.
- **Checkpoints and handlers:** untouched.
- **Saving a key from Perry (Part B)** goes through the engine and `saveApiKey`, so one program writes and reads keyring items, and no Keychain prompt appears.

## 7. Concepts

There's no new concept for users: "the keychain is another place your API key can live." Service `agency-lang` and account = the variable's name are easy to explain in one line. The GitHub token's entry is named `github-token`, not `GITHUB_TOKEN`. That's a small inconsistency worth one sentence in the docs, not a change.

## 8. Tying things together

- `loadApiKeys` and `saveApiKey` are exported through `agency-lang/stdlib-lib/apiKeys.js` for Perry. That ties Perry to their signatures, which is intended: the shared home means one storage format.
- The list of variables is tied to `PROVIDER_KEY_VARIABLES`. A new provider added there is then read from the keychain too, which is what anyone would expect.
