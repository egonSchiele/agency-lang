---
name: "index"
---

# index

## Functions

### createBranch

```ts
createBranch(name: string, from: string, owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| from | `string` | "" |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L20))

### deleteBranch

```ts
deleteBranch(name: string, owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L25))

### branchExists

```ts
branchExists(name: string, owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L30))

### commitFiles

```ts
commitFiles(message: string, files: string[], authorName: string, authorEmail: string, push: boolean, branch: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |
| files | `string[]` | [] |
| authorName | `string` | "" |
| authorEmail | `string` | "" |
| push | `boolean` | true |
| branch | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L35))

### openPullRequest

```ts
openPullRequest(title: string, body: string, head: string, base: string, draft: boolean, labels: string[], owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| body | `string` |  |
| head | `string` |  |
| base | `string` | "" |
| draft | `boolean` | false |
| labels | `string[]` | [] |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L47))

### listPullRequests

```ts
listPullRequests(state: string, base: string, head: string, owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `string` | "open" |
| base | `string` | "" |
| head | `string` | "" |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L52))

### commentOnPullRequest

```ts
commentOnPullRequest(number: number, body: string, owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| body | `string` |  |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L57))

### addLabel

```ts
addLabel(number: number, labels: string[], owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| labels | `string[]` |  |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L62))

### requestReview

```ts
requestReview(number: number, reviewers: string[], teamReviewers: string[], owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| reviewers | `string[]` | [] |
| teamReviewers | `string[]` | [] |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L67))

### listIssues

```ts
listIssues(state: string, labels: string[], owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| state | `string` | "open" |
| labels | `string[]` | [] |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L72))

### commentOnIssue

```ts
commentOnIssue(number: number, body: string, owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| number | `number` |  |
| body | `string` |  |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L77))

### createIssue

```ts
createIssue(title: string, body: string, labels: string[], owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| body | `string` |  |
| labels | `string[]` | [] |
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L82))

### defaultBranch

```ts
defaultBranch(owner: string, repo: string, token: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| owner | `string` | "" |
| repo | `string` | "" |
| token | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/github/index.agency#L87))
