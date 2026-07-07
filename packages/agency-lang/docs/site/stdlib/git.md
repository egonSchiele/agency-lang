---
name: "git"
---

# git

Typed, safe git tools. Each tool builds its own argv internally, so the
  model never supplies a raw flag — closing the `git diff --output=` /
  `-c core.pager=` class of abuse. Reads raise `std::git::<op>` effects the
  agent policy can auto-approve; writes prompt. Restrict any tool before
  handing it to an agent with `.partial()` — e.g. `gitCommit.partial(cwd: repo)`,
  `gitBranchDelete.partial(force: false, protectedBranches: ["main"])`,
  `gitAdd.partial(all: false, allowedPaths: ["src/"])`.

  ## The repo directory

  Every tool takes `cwd`, the git repo to operate on:

  - Leave it empty (the default) to use the **agent working directory** — the
    repo the CLI agent is running in (see `setAgentCwd`).
  - Pass an **absolute path** to target a specific repo (e.g. from a server
    backend with no agent cwd). `cwd` is used as given; it is NOT joined to the
    agent working directory.

  If neither is available the tool errors rather than silently running against
  whatever directory the process happens to be in.

  Note: positional values (refs/paths/branches) may not start with "-".

## Types

### GitRead

Read-only git effects — auto-approvable.

```ts
/** Read-only git effects — auto-approvable. */
export effectSet GitRead = <std::git::status, std::git::log, std::git::diff, std::git::show, std::git::branchList, std::git::remoteList, std::git::blame, std::git::stashList>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L59))

### GitWrite

Mutating git effects — should prompt.

```ts
/** Mutating git effects — should prompt. */
export effectSet GitWrite = <std::git::add, std::git::commit, std::git::checkout, std::git::switch, std::git::branchCreate, std::git::branchDelete, std::git::stashPush, std::git::stashPop, std::git::restore>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L61))

### Git

All git effects.

```ts
/** All git effects. */
export effectSet Git = <GitRead, GitWrite>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L63))

## Effects

### std::git::status

```ts
effect std::git::status {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L39))

### std::git::log

```ts
effect std::git::log {
  cwd: string;
  ref: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L40))

### std::git::diff

```ts
effect std::git::diff {
  cwd: string;
  ref: string;
  ref2: string;
  staged: boolean;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L41))

### std::git::show

```ts
effect std::git::show {
  cwd: string;
  ref: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L42))

### std::git::branchList

```ts
effect std::git::branchList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L43))

### std::git::remoteList

```ts
effect std::git::remoteList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L44))

### std::git::blame

```ts
effect std::git::blame {
  cwd: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L45))

### std::git::stashList

```ts
effect std::git::stashList {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L46))

### std::git::add

```ts
effect std::git::add {
  cwd: string;
  paths: string[];
  all: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L48))

### std::git::commit

```ts
effect std::git::commit {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L49))

### std::git::checkout

```ts
effect std::git::checkout {
  cwd: string;
  target: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L50))

### std::git::switch

```ts
effect std::git::switch {
  cwd: string;
  branch: string;
  create: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L51))

### std::git::branchCreate

```ts
effect std::git::branchCreate {
  cwd: string;
  branch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L52))

### std::git::branchDelete

```ts
effect std::git::branchDelete {
  cwd: string;
  branch: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L53))

### std::git::stashPush

```ts
effect std::git::stashPush {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L54))

### std::git::stashPop

```ts
effect std::git::stashPop {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L55))

### std::git::restore

```ts
effect std::git::restore {
  cwd: string;
  paths: string[];
  staged: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L56))

## Functions

### gitStatus

```ts
gitStatus(cwd: string): GitStatus
```

Show the working-tree status (branch, ahead/behind, changed files) as
  structured data.
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitStatus`

**Throws:** `std::git::status`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L78))

### gitLog

```ts
gitLog(n: number, oneline: boolean, path: string, ref: string, author: string, allowedPaths: string[], cwd: string): GitLog
```

Show commit history as structured commits.
  @param n - Max number of commits (default 20).
  @param oneline - Omit commit bodies.
  @param path - Limit to commits touching this path (may not start with "-").
  @param ref - Start from this revision (e.g. HEAD~5, a branch, a sha).
  @param author - Filter by author substring.
  @param allowedPaths - Restrict `path` to these prefixes (bind via .partial()).
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

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

**Returns:** `GitLog`

**Throws:** `std::git::log`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L89))

### gitDiff

```ts
gitDiff(ref: string, ref2: string, staged: boolean, path: string, allowedPaths: string[], cwd: string): GitDiff
```

Show a diff as a structured per-file summary plus the raw unified patch.
  @param ref - Compare against this revision (default: working tree vs index).
  @param ref2 - Optional second revision to diff ref..ref2.
  @param staged - Diff the index (staged changes) instead of the working tree.
  @param path - Limit the diff to this path (may not start with "-").
  @param allowedPaths - Restrict `path` to these prefixes (bind via .partial()).
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ref | `string` | "" |
| ref2 | `string` | "" |
| staged | `boolean` | false |
| path | `string` | "" |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `GitDiff`

**Throws:** `std::git::diff`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L112))

### gitShow

```ts
gitShow(ref: string, cwd: string): GitDiff
```

Show a commit as a structured per-file summary plus the raw patch. Line
  counts are approximate for merge commits (combined diffs are not counted).
  @param ref - The revision to show (default HEAD).
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ref | `string` | "HEAD" |
| cwd | `string` | "" |

**Returns:** `GitDiff`

**Throws:** `std::git::show`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L133))

### gitBranchList

```ts
gitBranchList(cwd: string): GitBranch[]
```

List local branches with their current-marker, upstream, and sha.
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitBranch[]`

**Throws:** `std::git::branchList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L145))

### gitRemoteList

```ts
gitRemoteList(cwd: string): GitRemote[]
```

List configured remotes with their fetch/push URLs.
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitRemote[]`

**Throws:** `std::git::remoteList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L155))

### gitBlame

```ts
gitBlame(path: string, ref: string, cwd: string): BlameLine[]
```

Show line-by-line authorship for a file.
  @param path - The file to blame (may not start with "-").
  @param ref - Optional revision to blame at.
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| ref | `string` | "" |
| cwd | `string` | "" |

**Returns:** `BlameLine[]`

**Throws:** `std::git::blame`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L165))

### gitStashList

```ts
gitStashList(cwd: string): GitStash[]
```

List stashes with their ref and description.
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `GitStash[]`

**Throws:** `std::git::stashList`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L177))

### gitAdd

```ts
gitAdd(paths: string[], all: boolean, allowedPaths: string[], cwd: string): string
```

Stage changes for commit.
  @param paths - Files to stage (may not start with "-").
  @param all - Stage all changes (git add -A). Bind `all: false` via .partial() to forbid.
  @param allowedPaths - Restrict `paths` to these prefixes (bind via .partial()).
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| paths | `string[]` | [] |
| all | `boolean` | false |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::add`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L189))

### gitCommit

```ts
gitCommit(message: string, cwd: string): string
```

Create a commit from the staged changes.
  @param message - The commit message.
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::commit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L205))

### gitCheckout

```ts
gitCheckout(target: string, force: boolean, cwd: string): string
```

Check out a branch, commit, or path.
  @param target - The branch/commit/path (may not start with "-").
  @param force - Discard local changes (git checkout --force). Bind `force: false` via .partial().
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| target | `string` |  |
| force | `boolean` | false |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::checkout`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L216))

### gitSwitch

```ts
gitSwitch(branch: string, create: boolean, cwd: string): string
```

Switch to a branch (optionally creating it).
  @param branch - The branch to switch to (may not start with "-").
  @param create - Create the branch first (git switch -c).
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| create | `boolean` | false |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::switch`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L232))

### gitBranchCreate

```ts
gitBranchCreate(branch: string, cwd: string): string
```

Create a new branch at HEAD (does not switch to it).
  @param branch - The new branch name (may not start with "-").
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::branchCreate`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L244))

### gitBranchDelete

```ts
gitBranchDelete(branch: string, force: boolean, protectedBranches: string[], cwd: string): string
```

Delete a local branch.
  @param branch - The branch to delete (may not start with "-").
  @param force - Delete even if unmerged (git branch -D). Bind `force: false` via .partial().
  @param protectedBranches - Branch names that may never be deleted (bind via .partial(), e.g. ["main","master"]).
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| branch | `string` |  |
| force | `boolean` | false |
| protectedBranches | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::branchDelete`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L256))

### gitStashPush

```ts
gitStashPush(message: string, cwd: string): string
```

Stash the working-tree changes.
  @param message - Optional stash message.
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` | "" |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::stashPush`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L275))

### gitStashPop

```ts
gitStashPop(cwd: string): string
```

Apply and drop the most recent stash.
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::stashPop`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L286))

### gitRestore

```ts
gitRestore(paths: string[], staged: boolean, allowedPaths: string[], cwd: string): string
```

Restore files, discarding changes (or unstaging with `staged`).
  @param paths - Files to restore (may not start with "-").
  @param staged - Restore the staged version (unstage) instead of discarding working-tree changes.
  @param allowedPaths - Restrict `paths` to these prefixes (bind via .partial()).
  @param cwd - The git repo directory. Defaults to the agent working directory; pass an absolute path to target a different repo.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| paths | `string[]` |  |
| staged | `boolean` | false |
| allowedPaths | `string[]` | [] |
| cwd | `string` | "" |

**Returns:** `string`

**Throws:** `std::git::restore`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/git.agency#L296))
