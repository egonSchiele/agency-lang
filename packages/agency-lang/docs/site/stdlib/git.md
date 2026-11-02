---
name: "git"
description: "Inspect repositories and manage local Git changes with typed tools."
---

# git

Inspect status, history, and diffs, or stage, commit, and restore local
  changes. Each operation has its own effect for handlers and policies.
  Bind restrictions before handing a tool to an agent, for example:
  `gitAdd.partial(all: false, allowedPaths: ["src/"])` or
  `gitBranchDelete.partial(force: false, protectedBranches: ["main"])`.

  Every tool takes an optional `cwd`, the repo to operate on. It defaults to the
  agent working directory (see `setAgentCwd`). Pass an absolute path to target a
  different repo.

  ```ts
  import { gitStatus, gitCommit } from "std::git"

  node main() {
    const status = gitStatus() with approve
    print(status.branch)
    gitCommit("Update docs") with approve
  }
  ```

## Types

### ChangeCode

git porcelain change codes: "." unmodified, "M" modified, "A" added,
  "D" deleted, "R" renamed, "C" copied, "U" unmerged, "T" type-changed,
  "?" untracked, "!" ignored.

```ts
/** git porcelain change codes: "." unmodified, "M" modified, "A" added,
  "D" deleted, "R" renamed, "C" copied, "U" unmerged, "T" type-changed,
  "?" untracked, "!" ignored. */
export type ChangeCode =
  | "."
  | "M"
  | "A"
  | "D"
  | "R"
  | "C"
  | "U"
  | "T"
  | "?"
  | "!"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L41))

### FileStatus

```ts
export type FileStatus = {
  path: string;
  index: ChangeCode;
  worktree: ChangeCode;
  renamedFrom?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L42))

### GitStatus

```ts
export type GitStatus = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  entries: FileStatus[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L48))

### GitCommit

```ts
export type GitCommit = {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L55))

### GitLog

```ts
export type GitLog = {
  commits: GitCommit[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L63))

### FileDiff

```ts
export type FileDiff = {
  path: string;
  status: ChangeCode;
  additions?: number;
  deletions?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L64))

### GitDiff

```ts
export type GitDiff = {
  files: FileDiff[];
  patch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L70))

### GitBranch

```ts
export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string;
  sha: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L71))

### BlameLine

```ts
export type BlameLine = {
  sha: string;
  author: string;
  line: number;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L77))

### GitRemote

```ts
export type GitRemote = {
  name: string;
  url: string;
  direction: "fetch" | "push"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L83))

### GitStash

```ts
export type GitStash = {
  ref: string;
  description: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L84))

### GitRead

Effects for reading repository state without changing it.

```ts
/** Effects for reading repository state without changing it. */
export effectSet GitRead = <std::git::status, std::git::log, std::git::diff, std::git::show, std::git::branchList, std::git::remoteList, std::git::blame, std::git::stashList>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L127))

### GitWrite

Effects for operations that change repository state.

```ts
/** Effects for operations that change repository state. */
export effectSet GitWrite = <std::git::add, std::git::commit, std::git::checkout, std::git::switch, std::git::branchCreate, std::git::branchDelete, std::git::stashPush, std::git::stashPop, std::git::restore>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L129))

### Git

All git effects.

```ts
/** All git effects. */
export effectSet Git = <GitRead, GitWrite>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L131))

## Effects

### std::git::status

```ts
@alwaysUnder(cwd)
effect std::git::status {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L91))

### std::git::log

```ts
@alwaysUnder(cwd)
effect std::git::log {
  cwd: string;
  ref: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L93))

### std::git::diff

```ts
@alwaysUnder(cwd)
effect std::git::diff {
  cwd: string;
  ref: string;
  ref2: string;
  staged: boolean;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L95))

### std::git::show

```ts
@alwaysUnder(cwd)
effect std::git::show {
  cwd: string;
  ref: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L97))

### std::git::branchList

```ts
@alwaysUnder(cwd)
effect std::git::branchList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L99))

### std::git::remoteList

```ts
@alwaysUnder(cwd)
effect std::git::remoteList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L101))

### std::git::blame

```ts
@alwaysUnder(cwd)
effect std::git::blame {
  cwd: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L103))

### std::git::stashList

```ts
@alwaysUnder(cwd)
effect std::git::stashList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L105))

### std::git::add

```ts
@alwaysUnder(cwd)
effect std::git::add {
  cwd: string;
  paths: string[];
  all: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L108))

### std::git::commit

```ts
@alwaysUnder(cwd)
effect std::git::commit {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L110))

### std::git::checkout

```ts
@alwaysUnder(cwd)
effect std::git::checkout {
  cwd: string;
  target: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L112))

### std::git::switch

```ts
@alwaysUnder(cwd)
effect std::git::switch {
  cwd: string;
  branch: string;
  create: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L114))

### std::git::branchCreate

```ts
@alwaysUnder(cwd)
effect std::git::branchCreate {
  cwd: string;
  branch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L116))

### std::git::branchDelete

```ts
@alwaysUnder(cwd)
effect std::git::branchDelete {
  cwd: string;
  branch: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L118))

### std::git::stashPush

```ts
@alwaysUnder(cwd)
effect std::git::stashPush {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L120))

### std::git::stashPop

```ts
@alwaysUnder(cwd)
effect std::git::stashPop {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L122))

### std::git::restore

```ts
@alwaysUnder(cwd)
effect std::git::restore {
  cwd: string;
  paths: string[];
  staged: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L124))

## Functions

### gitIsRepo

```ts
gitIsRepo(cwd: string = ""): boolean raises <std::git::status>
```

Check whether a directory is inside a Git worktree, returning false for a missing or non-repository directory.

  @param cwd - An absolute directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `boolean`

**Throws:** `std::git::status`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L147))

### gitStatus

```ts
gitStatus(cwd: string = ""): GitStatus raises <std::git::status>
```

Inspect staged and unstaged repository changes.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** [GitStatus](#gitstatus)

**Throws:** `std::git::status`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L159))

### gitLog

```ts
gitLog(
  n: number = 20,
  oneline: boolean = false,
  path: string = "",
  ref: string = "",
  author: string = "",
  allowedPaths: string[] = [],
  cwd: string = "",
): GitLog raises <std::git::log>
```

Show commit history as structured commits.
  @param n - The maximum commits to return, or zero or less for all matching commits.
  @param oneline - Omit commit bodies.
  @param path - Limit to commits touching this path (may not start with "-").
  @param ref - Start from this revision, such as HEAD~5 or a SHA, without a leading "-".
  @param author - Filter by author substring.
  @param allowedPaths - If non-empty, path must fall under one of these prefixes.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

`allowedPaths` is a developer guardrail: bind a prefix list via `.partial()`
    to constrain which paths the model may query.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` | 20 |
| oneline | `boolean` | false |
| path | `string` | "" |
| ref | `string` | "" |
| author | `string` | "" |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** [GitLog](#gitlog)

**Throws:** `std::git::log`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L172))

### gitDiff

```ts
gitDiff(
  ref: string = "",
  ref2: string = "",
  staged: boolean = false,
  path: string = "",
  allowedPaths: string[] = [],
  cwd: string = "",
): GitDiff raises <std::git::diff>
```

Show a diff as a structured per-file summary plus the raw unified patch.
  @param ref - Compare against this revision (default: working tree vs index).
  @param ref2 - Compare ref against this second revision, without a leading "-".
  @param staged - Diff the index (staged changes) instead of the working tree.
  @param path - Limit the diff to this path (may not start with "-").
  @param allowedPaths - If non-empty, path must fall under one of these prefixes.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

`allowedPaths` is a developer guardrail: bind a prefix list via `.partial()`
    to constrain which paths the model may diff.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ref | `string` | "" |
| ref2 | `string` | "" |
| staged | `boolean` | false |
| path | `string` | "" |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** [GitDiff](#gitdiff)

**Throws:** `std::git::diff`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L198))

### gitShow

```ts
gitShow(ref: string = "HEAD", cwd: string = ""): GitDiff raises <std::git::show>
```

Show a commit’s per-file changes and unified patch.
  @param ref - A revision such as HEAD or a SHA, without a leading "-".
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

Line counts are approximate for merge commits because combined diffs
  are not counted by the summary parser.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ref | `string` | "HEAD" |
| cwd | `string` | "" |

**Returns:** [GitDiff](#gitdiff)

**Throws:** `std::git::show`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L224))

### gitBranchList

```ts
gitBranchList(cwd: string = ""): GitBranch[] raises <std::git::branchList>
```

List local Git branches.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitBranch[]`

**Throws:** `std::git::branchList`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L236))

### gitRemoteList

```ts
gitRemoteList(cwd: string = ""): GitRemote[] raises <std::git::remoteList>
```

List configured remotes with their fetch/push URLs.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitRemote[]`

**Throws:** `std::git::remoteList`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L247))

### gitBlame

```ts
gitBlame(
  path: string,
  ref: string = "",
  cwd: string = "",
): BlameLine[] raises <std::git::blame>
```

Show line-by-line authorship for a file.
  @param path - The file to blame (may not start with "-").
  @param ref - A revision without a leading "-", or empty for the working tree.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| ref | `string` | "" |
| cwd | `string` | "" |

**Returns:** `BlameLine[]`

**Throws:** `std::git::blame`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L258))

### gitStashList

```ts
gitStashList(cwd: string = ""): GitStash[] raises <std::git::stashList>
```

List stashes with their ref and description.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitStash[]`

**Throws:** `std::git::stashList`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L271))

### gitAdd

```ts
gitAdd(
  paths: string[] = [],
  all: boolean = false,
  allowedPaths: string[] = [],
  cwd: string = "",
): string raises <std::git::add>
```

Stage changes for commit.
  @param paths - Files to stage (may not start with "-").
  @param all - Stage all repository changes, which cannot be combined with allowedPaths.
  @param allowedPaths - If non-empty, each path must fall under one of these prefixes.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

`all` and `allowedPaths` are developer guardrails: bind `all: false` and/or
    a prefix list for `allowedPaths` via `.partial()` before handing this to an
    agent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| paths | `string[]` | [] |
| all | `boolean` | false |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::add`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L287))

### gitCommit

```ts
gitCommit(message: string, cwd: string = ""): string raises <std::git::commit>
```

Create a commit from the staged changes.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::commit`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L306))

### gitCheckout

```ts
gitCheckout(
  target: string,
  force: boolean = false,
  cwd: string = "",
): string raises <std::git::checkout>
```

Check out a branch, commit, or path.
  @param target - The branch/commit/path (may not start with "-").
  @param force - Discard local changes while checking out (git checkout --force).
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

Bind `force: false` via `.partial()` to forbid discarding local changes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| target | `string` |  |
| force | `boolean` | false |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::checkout`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L320))

### gitSwitch

```ts
gitSwitch(
  branch: string,
  create: boolean = false,
  cwd: string = "",
): string raises <std::git::switch>
```

Switch to a branch.
  @param branch - The branch to switch to (may not start with "-").
  @param create - Create the branch first (git switch -c).
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| create | `boolean` | false |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::switch`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L339))

### gitBranchCreate

```ts
gitBranchCreate(
  branch: string,
  cwd: string = "",
): string raises <std::git::branchCreate>
```

Create a new branch at HEAD (does not switch to it).
  @param branch - The new branch name (may not start with "-").
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::branchCreate`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L354))

### gitBranchDelete

```ts
gitBranchDelete(
  branch: string,
  force: boolean = false,
  protectedBranches: string[] = [],
  cwd: string = "",
): string raises <std::git::branchDelete>
```

Delete a local branch.
  @param branch - The branch to delete (may not start with "-").
  @param force - Delete even if the branch is unmerged (git branch -D).
  @param protectedBranches - Branch names that may never be deleted (e.g. ["main", "master"]).
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

Guardrails: bind `force: false` and/or a `protectedBranches` list via
    `.partial()` before handing this to an agent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| force | `boolean` | false |
| protectedBranches | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::branchDelete`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L371))

### gitStashPush

```ts
gitStashPush(
  message: string = "",
  cwd: string = "",
): string raises <std::git::stashPush>
```

Stash the working-tree changes.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` | "" |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::stashPush`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L393))

### gitStashPop

```ts
gitStashPop(cwd: string = ""): string raises <std::git::stashPop>
```

Apply and drop the most recent stash.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::stashPop`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L406))

### gitRestore

```ts
gitRestore(
  paths: string[],
  staged: boolean = false,
  allowedPaths: string[] = [],
  cwd: string = "",
): string raises <std::git::restore>
```

Restore files to a previous state.
  @param paths - Files to restore (may not start with "-").
  @param staged - Unstage the files instead of discarding working-tree changes.
  @param allowedPaths - If non-empty, each path must fall under one of these prefixes.
  @param cwd - An absolute repository directory, or empty to use the agent working directory.

`allowedPaths` is a developer guardrail: bind a prefix list via `.partial()`
    to constrain which paths the model may restore.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| paths | `string[]` |  |
| staged | `boolean` | false |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::restore`

**Needs:** `fileRead`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L421))
