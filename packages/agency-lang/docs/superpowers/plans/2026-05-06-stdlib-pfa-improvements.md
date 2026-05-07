# Stdlib PFA Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify stdlib functions to work better with partial application by splitting compound parameters and adding safety constraint parameters.

**Architecture:** Three categories of changes: (1) FS functions split `filename` into `dir` + `filename`, (2) HTTP functions split `url` into `baseUrl` + `path` and add `headers`/`allowedDomains`, (3) messaging functions (email/iMessage/SMS) add `allowList`/`blockList`. All constraint violations return `failure()` Results. Changes touch both the Agency wrappers (`.agency` files) and their JS/TS implementations (`stdlib/lib/*.ts`).

**Tech Stack:** Agency language, TypeScript, vitest

---

### File Map

**FS changes:**
- Modify: `stdlib/index.agency` — split `read`, `write`, `readImage` params
- Modify: `stdlib/lib/builtins.ts` — update `_read`, `_write`, `_readImage` to accept `dir` + `filename`
- Modify: `stdlib/fs.agency` — split `edit`, `multiedit` params
- Modify: `stdlib/lib/fs.ts` — update `_edit`, `_multiedit` to accept `dir` + `filename`
- Modify: `tests/agency/builtins/readFile.agency` — update to new signature
- Modify: `tests/agency-js/stdlib/std-fs-edit/agent.agency` — update to new signature
- Modify: `tests/agency-js/stdlib/std-fs-edit-reject/agent.agency` — update to new signature
- Modify: `tests/agency-js/stdlib/std-fs-multiedit/agent.agency` — update to new signature
- Modify: `tests/agency-js/stdlib/std-fs-applyPatch/agent.agency` — update `read()` call to new signature
- Modify: `tests/formatter/roundtrip.agency` — update `read()` call to new signature

**HTTP changes:**
- Modify: `stdlib/index.agency` — update builtin `fetch`, `fetchJSON`
- Modify: `stdlib/lib/builtins.ts` — remove `_fetch`/`_fetchJSON` (delegate to `http.ts` versions), update `_read`, `_write`, `_readImage`
- Modify: `stdlib/http.agency` — update `fetch`, `fetchJSON`, `webfetch`
- Modify: `stdlib/lib/http.ts` — update `_fetch`, `_fetchJSON`, `_webfetch`, add `resolveUrl` and `checkAllowedDomains` helpers
- Modify: `tests/typescriptPreprocessor/tools.agency` — update `fetch()` to new signature

**Messaging changes:**
- Modify: `stdlib/email.agency` — add `allowList`/`blockList` to all 3 send functions
- Modify: `stdlib/lib/email.ts` — add `checkRecipients` helper, thread lists through
- Modify: `stdlib/imessage.agency` — add `allowList`/`blockList` to `sendIMessage`
- Modify: `stdlib/lib/imessage.ts` — add recipient check
- Modify: `stdlib/sms.agency` — add `allowList`/`blockList` to `sendSms`
- Modify: `stdlib/lib/sms.ts` — add recipient check

**Tests:**
- Create: `stdlib/lib/http.test.ts` — unit tests for URL resolution and domain checking
- Create: `stdlib/lib/messaging.test.ts` — unit tests for recipient allow/block list logic

**Docs (auto-generated, but module docstrings need updating):**
- The `@module` docstrings in the `.agency` files need to be updated with new signatures/examples

---

### Task 1: Add shared recipient-checking helper

**Files:**
- Create: `stdlib/lib/messaging.ts`
- Create: `stdlib/lib/messaging.test.ts`

- [ ] **Step 1: Write the failing test**

Create `stdlib/lib/messaging.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { checkRecipients } from "./messaging.js";

describe("checkRecipients", () => {
  it("passes when no lists are set", () => {
    const result = checkRecipients(["alice@example.com"], [], []);
    expect(result).toBeNull();
  });

  it("passes when recipient is in allowList", () => {
    const result = checkRecipients(
      ["alice@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toBeNull();
  });

  it("fails when recipient is not in allowList", () => {
    const result = checkRecipients(
      ["bob@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toContain("bob@example.com");
    expect(result).toContain("not in allowList");
  });

  it("fails when recipient is in blockList", () => {
    const result = checkRecipients(
      ["alice@example.com"],
      [],
      ["alice@example.com"],
    );
    expect(result).toContain("alice@example.com");
    expect(result).toContain("blockList");
  });

  it("checks all recipients (to, cc, bcc)", () => {
    const result = checkRecipients(
      ["alice@example.com", "eve@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toContain("eve@example.com");
  });

  it("allowList takes precedence when both are empty", () => {
    const result = checkRecipients(["anyone@example.com"], [], []);
    expect(result).toBeNull();
  });

  it("is case-insensitive", () => {
    const result = checkRecipients(
      ["Alice@Example.COM"],
      ["alice@example.com"],
      [],
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && pnpm vitest run stdlib/lib/messaging.test.ts 2>&1 | tee /tmp/claude/test-messaging-1.txt`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `stdlib/lib/messaging.ts`:

```typescript
/**
 * Shared recipient-checking logic for email, iMessage, and SMS.
 * Returns null if all recipients are allowed, or an error message string if any are blocked.
 */
export function checkRecipients(
  recipients: string[],
  allowList: string[],
  blockList: string[],
): string | null {
  if (allowList.length === 0 && blockList.length === 0) return null;

  const normalize = (s: string) => s.toLowerCase().trim();
  const normalizedAllow = allowList.map(normalize);
  const normalizedBlock = blockList.map(normalize);

  for (const r of recipients) {
    const nr = normalize(r);
    if (nr === "") continue;

    if (normalizedBlock.length > 0 && normalizedBlock.includes(nr)) {
      return `Recipient "${r}" is in the blockList.`;
    }

    if (normalizedAllow.length > 0 && !normalizedAllow.includes(nr)) {
      return `Recipient "${r}" is not in the allowList.`;
    }
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && pnpm vitest run stdlib/lib/messaging.test.ts 2>&1 | tee /tmp/claude/test-messaging-2.txt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add stdlib/lib/messaging.ts stdlib/lib/messaging.test.ts
git commit -m "Add shared checkRecipients helper for messaging stdlib"
```

---

### Task 2: Add URL resolution and domain-checking helpers for HTTP

**Files:**
- Modify: `stdlib/lib/http.ts`
- Create: `stdlib/lib/http.test.ts`

- [ ] **Step 1: Write the failing test**

Create `stdlib/lib/http.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveUrl, checkAllowedDomains } from "./http.js";

describe("resolveUrl", () => {
  it("joins baseUrl and path", () => {
    expect(resolveUrl("https://api.github.com", "/repos")).toBe(
      "https://api.github.com/repos",
    );
  });

  it("uses baseUrl alone when path is empty", () => {
    expect(resolveUrl("https://api.github.com", "")).toBe(
      "https://api.github.com",
    );
  });

  it("handles trailing slash on baseUrl", () => {
    expect(resolveUrl("https://api.github.com/", "/repos")).toBe(
      "https://api.github.com/repos",
    );
  });

  it("handles path without leading slash", () => {
    expect(resolveUrl("https://api.github.com", "repos")).toBe(
      "https://api.github.com/repos",
    );
  });

  it("handles both trailing and leading slashes", () => {
    expect(resolveUrl("https://api.github.com/", "repos")).toBe(
      "https://api.github.com/repos",
    );
  });
});

describe("checkAllowedDomains", () => {
  it("returns null when allowedDomains is empty", () => {
    expect(checkAllowedDomains("https://evil.com", [])).toBeNull();
  });

  it("returns null when domain is in list", () => {
    expect(
      checkAllowedDomains("https://api.github.com/repos", [
        "api.github.com",
      ]),
    ).toBeNull();
  });

  it("returns error when domain is not in list", () => {
    const result = checkAllowedDomains("https://evil.com/data", [
      "api.github.com",
    ]);
    expect(result).toContain("evil.com");
    expect(result).toContain("not in allowedDomains");
  });

  it("is case-insensitive", () => {
    expect(
      checkAllowedDomains("https://API.GitHub.COM/repos", [
        "api.github.com",
      ]),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && pnpm vitest run stdlib/lib/http.test.ts 2>&1 | tee /tmp/claude/test-http-1.txt`
Expected: FAIL — functions not exported

- [ ] **Step 3: Add helpers to `stdlib/lib/http.ts`**

Add these exported functions at the bottom of `stdlib/lib/http.ts`:

```typescript
export function resolveUrl(baseUrl: string, path: string): string {
  if (!path) return baseUrl;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : "/" + path;
  return base + p;
}

export function checkAllowedDomains(
  url: string,
  allowedDomains: string[],
): string | null {
  if (allowedDomains.length === 0) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const allowed = allowedDomains.map((d) => d.toLowerCase());
    if (!allowed.includes(hostname)) {
      return `Domain "${hostname}" is not in allowedDomains.`;
    }
    return null;
  } catch {
    return `Invalid URL: "${url}"`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && pnpm vitest run stdlib/lib/http.test.ts 2>&1 | tee /tmp/claude/test-http-2.txt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add stdlib/lib/http.ts stdlib/lib/http.test.ts
git commit -m "Add resolveUrl and checkAllowedDomains helpers for HTTP stdlib"
```

---

### Task 3: Update FS functions — split `filename` into `dir` + `filename`

**Files:**
- Modify: `stdlib/lib/builtins.ts` — `_read`, `_write`, `_readImage`
- Modify: `stdlib/lib/fs.ts` — `_edit`, `_multiedit`
- Modify: `stdlib/index.agency` — `read`, `write`, `readImage`
- Modify: `stdlib/fs.agency` — `edit`, `multiedit`

The pattern for all functions: add a `dir` parameter. If `dir` is non-empty, resolve `path.join(dir, filename)` instead of just `filename`.

- [ ] **Step 1: Update `_read`, `_write`, `_readImage` in `stdlib/lib/builtins.ts`**

Add a `resolvePath` helper and update all three functions:

```typescript
function resolvePath(dir: string, filename: string): string {
  const combined = dir ? path.join(dir, filename) : filename;
  return path.resolve(process.cwd(), combined);
}
```

Change `_read` signature from `(filename: string)` to `(dir: string, filename: string)`:
```typescript
export async function _read(dir: string, filename: string): Promise<string> {
  const filePath = resolvePath(dir, filename);
  const data = await readFile(filePath);
  return data.toString("utf8");
}
```

Same for `_write`:
```typescript
export async function _write(dir: string, filename: string, content: string): Promise<boolean> {
  const filePath = resolvePath(dir, filename);
  await writeFile(filePath, content, "utf8");
  return true;
}
```

Same for `_readImage`:
```typescript
export async function _readImage(dir: string, filename: string): Promise<string> {
  const filePath = resolvePath(dir, filename);
  const data = await readFile(filePath);
  return data.toString("base64");
}
```

- [ ] **Step 2: Update `read`, `write`, `readImage` in `stdlib/index.agency`**

Change the Agency wrappers. Note the import line must also be updated if needed (it imports `_read`, `_write`, `_readImage` which don't change names).

`read`:
```
export def read(dir: string, filename: string): string {
  """
  A tool for reading the contents of a file and returning it as a string. If dir is provided, the filename is resolved relative to that directory.

  @param dir - The directory containing the file (use "" for current directory)
  @param filename - The file to read
  """
  return interrupt std::read("Are you sure you want to read this file?", {
    dir: dir,
    filename: filename
  })
  return _read(dir, filename)
}
```

`write`:
```
export def write(dir: string, filename: string, content: string) {
  """
  A tool for writing content to a file. If dir is provided, the filename is resolved relative to that directory.

  @param dir - The directory containing the file (use "" for current directory)
  @param filename - The file to write
  @param content - The content to write
  """
  return interrupt std::write("Are you sure you want to write to this file?", {
    dir: dir,
    filename: filename,
    content: content
  })
  _write(dir, filename, content)
}
```

`readImage`:
```
export def readImage(dir: string, filename: string): string {
  """
  A tool for reading an image file and returning its contents as a Base64-encoded string. If dir is provided, the filename is resolved relative to that directory.

  @param dir - The directory containing the file (use "" for current directory)
  @param filename - The image file to read
  """
  return interrupt std::readImage("Are you sure you want to read this image file?", {
    dir: dir,
    filename: filename
  })
  return _readImage(dir, filename)
}
```

- [ ] **Step 3: Add `resolvePath` helper to `stdlib/lib/fs.ts` and update `_edit`, `_multiedit`**

Add the same helper pattern. Change `_edit` signature from `(filename, oldText, newText, replaceAll)` to `(dir, filename, oldText, newText, replaceAll)`:

```typescript
function resolvePath(dir: string, filename: string): string {
  const combined = dir ? path.join(dir, filename) : filename;
  return path.resolve(process.cwd(), combined);
}
```

In `_edit`, replace:
```typescript
const full = path.resolve(process.cwd(), filename);
```
with:
```typescript
const full = resolvePath(dir, filename);
```

Same for `_multiedit`.

- [ ] **Step 4: Update `edit`, `multiedit` in `stdlib/fs.agency`**

`edit`:
```
export def edit(dir: string, filename: string, oldText: string, newText: string, replaceAll: boolean = false): Result {
  """
  Edit a file by replacing oldText with newText. By default oldText must match exactly once in the file; pass replaceAll=true to replace every occurrence. Fails if oldText is not found or appears multiple times (unless replaceAll is set).

  @param dir - The directory containing the file (use "" for current directory)
  @param filename - The file to edit
  @param oldText - The text to find
  @param newText - The replacement text
  @param replaceAll - Replace all occurrences instead of just the first
  """
  return interrupt std::edit("Are you sure you want to edit this file?", {
    dir: dir,
    filename: filename,
    oldText: oldText,
    newText: newText,
    replaceAll: replaceAll
  })

  return try _edit(dir, filename, oldText, newText, replaceAll)
}
```

`multiedit`:
```
export def multiedit(dir: string, filename: string, edits: Edit[]): Result {
  """
  Apply a sequence of edits to a single file atomically. Each edit has oldText, newText, and replaceAll. Fails if any edit's oldText is not found or is ambiguous; when any edit fails, nothing is written.

  @param dir - The directory containing the file (use "" for current directory)
  @param filename - The file to edit
  @param edits - Array of edit objects with oldText, newText, and replaceAll
  """
  return interrupt std::multiedit("Are you sure you want to apply these edits?", {
    dir: dir,
    filename: filename,
    edits: edits
  })

  return try _multiedit(dir, filename, edits)
}
```

- [ ] **Step 5: Update existing tests**

Update `tests/agency/builtins/readFile.agency`:
```
node main() {
  handle {
    const contents = read("", "tests/agency/builtins/testdata.txt")
  } with (data) {
    return approve()
  }
  return contents
}
```

Update `tests/agency-js/stdlib/std-fs-edit/agent.agency`:
```
import { edit } from "std::fs"

node writeFixture(filename: string, content: string) {
  handle {
    write("", filename, content)
  } with (data) {
    return approve()
  }
  return true
}

node readBack(filename: string) {
  handle {
    const result = read("", filename)
  } with (data) {
    return approve()
  }
  return result
}

node runEdit(filename: string, oldText: string, newText: string, replaceAll: boolean) {
  handle {
    const result = edit("", filename, oldText, newText, replaceAll)
  } with (data) {
    return approve()
  }
  return result
}
```

Update `tests/agency-js/stdlib/std-fs-edit-reject/agent.agency`:
```
import { edit } from "std::fs"

node writeFixture(filename: string, content: string) {
  write("", filename, content) with approve
  return true
}

node readBack(filename: string) {
  const result = read("", filename) with approve
  return result
}

node runEdit(filename: string, oldText: string, newText: string, replaceAll: boolean) {
  const result = edit("", filename, oldText, newText, replaceAll)
  return result
}
```

Update `tests/agency-js/stdlib/std-fs-multiedit/agent.agency`:
```
import { multiedit } from "std::fs"

node writeFixture(filename: string, content: string) {
  write("", filename, content) with approve
  return true
}

node readBack(filename: string) {
  const result = read("", filename) with approve
  return result
}

type Edit = {
  oldText: string;
  newText: string;
  replaceAll: boolean
}

node runMultiedit(filename: string, edits: Edit[]) {
  const result = multiedit("", filename, edits) with approve
  return result
}
```

Update `tests/agency-js/stdlib/std-fs-applyPatch/agent.agency`:
```
import { applyPatch } from "std::fs"

node runApply(patch: string) {
  handle {
    const result = applyPatch(patch)
  } with (data) {
    return approve()
  }
  return result
}

node readBack(filename: string) {
  handle {
    const result = read("", filename)
  } with (data) {
    return approve()
  }
  return result
}
```

Update `tests/formatter/roundtrip.agency` line 101 — change:
```
const foo = read("foo.txt") with reject
```
to:
```
const foo = read("", "foo.txt") with reject
```

Also grep for any other tests that use `read(` or `write(` with the old single-arg pattern and update them.

- [ ] **Step 6: Build and run tests**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && make 2>&1 | tee /tmp/claude/build-fs.txt`
Then: `pnpm vitest run tests/agency/builtins/readFile 2>&1 | tee /tmp/claude/test-readfile.txt`
Then: `pnpm vitest run tests/agency-js/stdlib/std-fs 2>&1 | tee /tmp/claude/test-fs-edit.txt`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add stdlib/index.agency stdlib/lib/builtins.ts stdlib/fs.agency stdlib/lib/fs.ts tests/
git commit -m "Split filename into dir + filename in FS and builtin read/write functions"
```

---

### Task 4: Update HTTP functions — split `url` into `baseUrl` + `path`, add `headers` and `allowedDomains`

**Files:**
- Modify: `stdlib/lib/http.ts` — update `_fetch`, `_fetchJSON`, `_webfetch` signatures
- Modify: `stdlib/lib/builtins.ts` — update `_fetch`, `_fetchJSON` signatures
- Modify: `stdlib/http.agency` — update `fetch`, `fetchJSON`, `webfetch`
- Modify: `stdlib/index.agency` — update builtin `fetch`, `fetchJSON`

- [ ] **Step 1: Update `_fetch`, `_fetchJSON`, `_webfetch` in `stdlib/lib/http.ts`**

Change all three functions to accept `(baseUrl, path, headers, allowedDomains)`. Use the `resolveUrl` and `checkAllowedDomains` helpers added in Task 2.

```typescript
export async function _fetch(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
  allowedDomains: string[],
): Promise<string> {
  const url = resolveUrl(baseUrl, urlPath);
  const domainError = checkAllowedDomains(url, allowedDomains);
  if (domainError) throw new Error(domainError);
  const result = await fetch(url, { headers });
  try {
    return await readBodyCapped(result, url);
  } catch (e) {
    throw new Error(`Failed to get text from ${url}: ${e}`);
  }
}
```

Same pattern for `_fetchJSON` and `_webfetch`.

- [ ] **Step 2: Remove duplicate `_fetch`, `_fetchJSON` from `stdlib/lib/builtins.ts` — delegate to `http.ts`**

Currently `builtins.ts` has its own `_fetch`/`_fetchJSON` that lack the 10MB cap. Remove them and re-export from `http.ts` instead, so there's one implementation:

Replace the two function definitions with re-exports:
```typescript
export { _fetch, _fetchJSON } from "./http.js";
```

Remove the old `_fetch` and `_fetchJSON` function bodies from `builtins.ts`.

- [ ] **Step 2b: Update `tests/typescriptPreprocessor/tools.agency`**

The test uses `fetch("https://weather.example.com/${city}")`. Since the first param is now `baseUrl`, this still works semantically (the full URL as baseUrl with no path). No change needed — just verify it still compiles by running `pnpm run ast tests/typescriptPreprocessor/tools.agency`.

- [ ] **Step 3: Update `fetch`, `fetchJSON`, `webfetch` in `stdlib/http.agency`**

```
export def fetch(baseUrl: string, path: string = "", headers: object = {}, allowedDomains: string[] = []): Result {
  """
  Fetch a URL and return the response body as text. Provide baseUrl and optionally path (they are joined). Set headers for custom request headers. Set allowedDomains to restrict which domains can be fetched. Fails on network errors, domain violations, or if the response body exceeds 10 MB.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)
  """
  return interrupt std::http::fetch("Are you sure you want to fetch this URL?", {
    baseUrl: baseUrl,
    path: path
  })
  return try _fetch(baseUrl, path, headers, allowedDomains)
}
```

Same pattern for `fetchJSON` and `webfetch`.

- [ ] **Step 4: Update builtin `fetch`, `fetchJSON` in `stdlib/index.agency`**

```
export def fetch(baseUrl: string, path: string = "", headers: object = {}, allowedDomains: string[] = []): string {
  """
  A tool for fetching a URL and returning the response as text. Provide baseUrl and optionally path (they are joined). Set headers for custom request headers. Set allowedDomains to restrict which domains can be fetched.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)
  """
  return interrupt std::fetch("Are you sure you want to fetch this URL?", {
    baseUrl: baseUrl,
    path: path
  })
  return _fetch(baseUrl, path, headers, allowedDomains)
}
```

Same for `fetchJSON`.

- [ ] **Step 5: Build and verify**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && make 2>&1 | tee /tmp/claude/build-http.txt`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add stdlib/index.agency stdlib/lib/builtins.ts stdlib/http.agency stdlib/lib/http.ts
git commit -m "Split url into baseUrl + path, add headers and allowedDomains to HTTP functions"
```

---

### Task 5: Add `allowList`/`blockList` to email functions

**Files:**
- Modify: `stdlib/email.agency` — add params to all 3 functions
- Modify: `stdlib/lib/email.ts` — add recipient checking

- [ ] **Step 1: Update `stdlib/lib/email.ts`**

Import the helper:
```typescript
import { checkRecipients } from "./messaging.js";
```

Add a shared function to collect all recipients from EmailParams:
```typescript
function collectRecipients(params: EmailParams): string[] {
  const recipients: string[] = [];
  recipients.push(...toArray(params.to));
  if (params.cc) recipients.push(...toArray(params.cc));
  if (params.bcc) recipients.push(...toArray(params.bcc));
  return recipients;
}
```

Update all three send functions. Add `allowList` and `blockList` to their options types. At the top of each function, before any API call:

```typescript
const recipientError = checkRecipients(
  collectRecipients(params),
  options?.allowList ?? [],
  options?.blockList ?? [],
);
if (recipientError) throw new Error(recipientError);
```

Update option types:
```typescript
export type ResendOptions = {
  apiKey?: string;
  allowList?: string[];
  blockList?: string[];
};
```
(Same for `SendGridOptions` and `MailgunOptions`.)

- [ ] **Step 2: Update `stdlib/email.agency`**

Add `allowList` and `blockList` params (with default `[]`) to all three send functions. Thread them through to the JS implementation.

For `sendWithResend`:
```
export def sendWithResend(from: string, to: string, subject: string, html: string = "", text: string = "", cc: string = "", bcc: string = "", replyTo: string = "", apiKey: string = "", allowList: string[] = [], blockList: string[] = []): Result {
  """
  Send an email using the Resend API. Requires RESEND_API_KEY env var or pass apiKey directly. Set allowList to restrict recipients to specific addresses. Set blockList to reject specific addresses.

  @param from - Sender email address
  @param to - Recipient email address
  @param subject - Email subject
  @param html - HTML content
  @param text - Plain text content
  @param cc - CC recipients
  @param bcc - BCC recipients
  @param replyTo - Reply-to address
  @param apiKey - Resend API key
  @param allowList - Only allow sending to these addresses
  @param blockList - Block sending to these addresses
  """
  return interrupt std::sendEmail("Are you sure you want to send this email via Resend?", {
    from: from,
    to: to,
    subject: subject
  })

  return try _sendWithResend({
    from: from,
    to: to,
    subject: subject,
    html: html,
    text: text,
    cc: cc,
    bcc: bcc,
    replyTo: replyTo
  }, {
    apiKey: apiKey,
    allowList: allowList,
    blockList: blockList
  })
}
```

Same pattern for `sendWithSendGrid` and `sendWithMailgun` (Mailgun also threads `domain` and `region`).

- [ ] **Step 3: Build and verify**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && make 2>&1 | tee /tmp/claude/build-email.txt`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add stdlib/email.agency stdlib/lib/email.ts
git commit -m "Add allowList and blockList to email send functions"
```

---

### Task 6: Add `allowList`/`blockList` to iMessage and SMS

**Files:**
- Modify: `stdlib/imessage.agency`
- Modify: `stdlib/lib/imessage.ts`
- Modify: `stdlib/sms.agency`
- Modify: `stdlib/lib/sms.ts`

- [ ] **Step 1: Update `stdlib/lib/imessage.ts`**

Import helper and add check:
```typescript
import { checkRecipients } from "./messaging.js";
```

Update `_sendIMessage` signature to accept `options`:
```typescript
export type IMessageOptions = {
  allowList?: string[];
  blockList?: string[];
};

export async function _sendIMessage(
  to: string,
  message: string,
  options?: IMessageOptions,
): Promise<IMessageResult> {
  // ... existing platform/validation checks ...

  const recipientError = checkRecipients(
    [to],
    options?.allowList ?? [],
    options?.blockList ?? [],
  );
  if (recipientError) throw new Error(recipientError);

  // ... rest of existing implementation ...
}
```

- [ ] **Step 2: Update `stdlib/imessage.agency`**

```
export def sendIMessage(to: string, message: string, allowList: string[] = [], blockList: string[] = []): Result {
  """
  Send an iMessage via the macOS Messages app. Only works on macOS with Messages.app signed in. Set allowList to restrict recipients to specific addresses/numbers. Set blockList to reject specific addresses/numbers.

  @param to - Phone number or email of the recipient
  @param message - The text to send
  @param allowList - Only allow sending to these addresses/numbers
  @param blockList - Block sending to these addresses/numbers
  """
  return interrupt std::sendIMessage("Are you sure you want to send this iMessage?", {
    to: to
  })

  return try _sendIMessage(to, message, {
    allowList: allowList,
    blockList: blockList
  })
}
```

- [ ] **Step 3: Update `stdlib/lib/sms.ts`**

Import helper and add `allowList`/`blockList` to `SmsOptions`:
```typescript
import { checkRecipients } from "./messaging.js";
```

```typescript
export type SmsOptions = {
  accountSid?: string;
  authToken?: string;
  from?: string;
  allowList?: string[];
  blockList?: string[];
};
```

Add check at top of `_sendSms`, after existing `to` validation:
```typescript
const recipientError = checkRecipients(
  [to],
  options?.allowList ?? [],
  options?.blockList ?? [],
);
if (recipientError) throw new Error(recipientError);
```

- [ ] **Step 4: Update `stdlib/sms.agency`**

```
export def sendSms(to: string, body: string, from: string = "", accountSid: string = "", authToken: string = "", allowList: string[] = [], blockList: string[] = []): Result {
  """
  Send an SMS text message via the Twilio API. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER env vars, or pass them directly. Set allowList to restrict recipients to specific numbers. Set blockList to reject specific numbers.

  @param to - Recipient phone number (E.164 format)
  @param body - Message text
  @param from - Sender phone number
  @param accountSid - Twilio account SID
  @param authToken - Twilio auth token
  @param allowList - Only allow sending to these numbers
  @param blockList - Block sending to these numbers
  """
  return interrupt std::sendSms("Are you sure you want to send this SMS?", {
    to: to
  })

  return try _sendSms(to, body, {
    from: from,
    accountSid: accountSid,
    authToken: authToken,
    allowList: allowList,
    blockList: blockList
  })
}
```

- [ ] **Step 5: Build and verify**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && make 2>&1 | tee /tmp/claude/build-messaging.txt`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add stdlib/imessage.agency stdlib/lib/imessage.ts stdlib/sms.agency stdlib/lib/sms.ts
git commit -m "Add allowList and blockList to iMessage and SMS functions"
```

---

### Task 7: Full build, test run, and update module docstrings

**Files:**
- Modify: `stdlib/email.agency` — update `@module` docstring with PFA examples
- Modify: `stdlib/http.agency` — add `@module` docstring if missing
- Rebuild docs

- [ ] **Step 1: Run full build**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && make 2>&1 | tee /tmp/claude/build-full.txt`
Expected: Build succeeds

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && pnpm test:run 2>&1 | tee /tmp/claude/test-full.txt`
Expected: All tests pass. If any fail, fix them before continuing.

- [ ] **Step 3: Run agency integration tests for affected modules**

Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && pnpm run agency test tests/agency/builtins/readFile.agency 2>&1 | tee /tmp/claude/test-agency-read.txt`
Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && pnpm run agency test js tests/agency-js/stdlib/std-fs-edit 2>&1 | tee /tmp/claude/test-agency-edit.txt`
Run: `cd /Users/adityabhargava/worktrees/agency-lang/packages/agency-lang && pnpm run agency test js tests/agency-js/stdlib/std-fs-multiedit 2>&1 | tee /tmp/claude/test-agency-multiedit.txt`
Expected: All pass

- [ ] **Step 4: Update email module docstring with PFA example**

In `stdlib/email.agency`, update the `@module` docstring to add a PFA example:

```
  ### Partial Application for Safety

  ```ts
  // Create a constrained email sender that only sends to your team
  const teamEmail = sendWithResend.partial(
    from: "noreply@myco.com",
    allowList: ["team@myco.com", "alerts@myco.com"]
  )

  // Now the agent can only email approved addresses
  teamEmail(to: "team@myco.com", subject: "Deploy complete", text: "v2.1 is live")
  ```
```

- [ ] **Step 5: Commit**

```bash
git add stdlib/email.agency
git commit -m "Update module docstrings with PFA examples"
```
