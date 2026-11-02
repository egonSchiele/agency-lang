---
name: "effectSets"
description: "Combine named groups of effects in raises clauses."
---

# effectSets

```ts
import { FileRead, Network } from "std::effectSets"

node inspect() raises <FileRead, Network> {
  return read("README.md")
}
```

A `raises` clause limits which interrupts a function may raise. Combine
sets to allow several kinds of action. Handlers and policies still decide
whether to approve each interrupt.

The sets group effects by action. Choose the groups your program needs;
a set does not decide whether an action is appropriate for your task.
Use specific effects in a function's `raises` clause when they describe
its behavior more precisely.

## Types

### FileRead

Read-only filesystem access: reading files and listing/searching paths.

```ts
/** Read-only filesystem access: reading files and listing/searching paths. */
export effectSet FileRead = <std::read, std::readBinary, std::ls, std::glob, std::grep, std::vision>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L23))

### FileWrite

Filesystem mutation: creating, editing, moving, copying, and deleting.

```ts
/** Filesystem mutation: creating, editing, moving, copying, and deleting. */
export effectSet FileWrite = <std::write, std::writeBinary, std::edit, std::applyPatch, std::mkdir, std::move, std::copy, std::remove, std::cropImage, std::pasteImages>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L26))

### FileSystem

Filesystem reads and writes covered by FileRead and FileWrite.

```ts
/** Filesystem reads and writes covered by FileRead and FileWrite. */
export effectSet FileSystem = <FileRead, FileWrite>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L29))

### Shell

Shell commands, program execution, and Agency subprocess runs.

```ts
/** Shell commands, program execution, and Agency subprocess runs. */
export effectSet Shell = <std::bash, std::exec, std::run>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L32))

### Network

Network effects for HTTP, search, browsers, and service integrations.

```ts
/** Network effects for HTTP, search, browsers, and service integrations. */
export effectSet Network = <std::http::fetch, std::http::fetchJSON, std::http::fetchMarkdown, std::search, std::tavilySearch, std::weather, std::browserUse, std::wikipedia::article, std::wikipedia::search, std::wikipedia::summary, std::gdelt, std::fred, std::dbnomics, std::edgar, std::littlesis, std::yc, std::hackernews, std::bluesky, std::wikidata, std::usaspending, std::aws::s3::get, std::aws::s3::getBinary, std::aws::s3::put, std::aws::s3::putBinary, std::aws::s3::createBucket, std::github::prList, std::github::prGet, std::github::prDiff, std::github::prFiles, std::github::prReviewList, std::github::prReviewCommentList, std::github::prChecks, std::github::issueList, std::github::issueGet, std::github::issueCommentList, std::github::issueSearch, std::github::prReviewComment, std::github::prReview, std::github::prApprove, std::github::issueCreate, std::github::issueComment, std::github::issueUpdate, std::github::issueLabel, std::uploadImage>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L35))

### AwsS3

S3 reads, writes, bucket creation, and presigned download URLs.
Presigning creates a download credential locally and has no network effect.

```ts
/**
S3 reads, writes, bucket creation, and presigned download URLs.
Presigning creates a download credential locally and has no network effect.
*/
export effectSet AwsS3 = <std::aws::s3::get, std::aws::s3::getBinary, std::aws::s3::put, std::aws::s3::putBinary, std::aws::s3::createBucket, std::aws::s3::presignGet>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L41))

### GithubRead

Read-only GitHub access: pull requests, issues, and their comments.

```ts
/** Read-only GitHub access: pull requests, issues, and their comments. */
export effectSet GithubRead = <std::github::prList, std::github::prGet, std::github::prDiff, std::github::prFiles, std::github::prReviewList, std::github::prReviewCommentList, std::github::prChecks, std::github::issueList, std::github::issueGet, std::github::issueCommentList, std::github::issueSearch>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L44))

### GithubReview

Posting comments and reviews on GitHub pull requests.

```ts
/** Posting comments and reviews on GitHub pull requests. */
export effectSet GithubReview = <std::github::prReviewComment, std::github::prReview, std::github::prApprove>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L47))

### GithubIssueWrite

Creating and editing GitHub issues.

```ts
/** Creating and editing GitHub issues. */
export effectSet GithubIssueWrite = <std::github::issueCreate, std::github::issueComment, std::github::issueUpdate, std::github::issueLabel>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L50))

### GithubWrite

All GitHub mutations.

```ts
/** All GitHub mutations. */
export effectSet GithubWrite = <GithubReview, GithubIssueWrite>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L53))

### Github

All GitHub access.

```ts
/** All GitHub access. */
export effectSet Github = <GithubRead, GithubWrite>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L56))

### DataFinance

Finance connector effects for macroeconomic data and filings.
Include Network as well for the HTTP effects their requests raise.

```ts
/**
Finance connector effects for macroeconomic data and filings.
Include Network as well for the HTTP effects their requests raise.
*/
export effectSet DataFinance = <std::fred, std::edgar, std::dbnomics>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L62))

### Messaging

Sending messages to people: email, SMS, and iMessage.

```ts
/** Sending messages to people: email, SMS, and iMessage. */
export effectSet Messaging = <std::sendEmail, std::sendSms, std::sendIMessage>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L65))

### Secrets

Reading and writing credentials in the system keyring.

```ts
/** Reading and writing credentials in the system keyring. */
export effectSet Secrets = <std::getSecret, std::setSecret, std::deleteSecret>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L68))

### Auth

OAuth-style authorization flows: granting, fetching, and revoking access.

```ts
/** OAuth-style authorization flows: granting, fetching, and revoking access. */
export effectSet Auth = <std::authorize, std::getAccessToken, std::revokeAuth>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L71))

### Calendar

Calendar access: listing and mutating events including calendar authorization.

```ts
/** Calendar access: listing and mutating events including calendar authorization. */
export effectSet Calendar = <std::listEvents, std::createEvent, std::updateEvent, std::deleteEvent, std::authorizeCalendar>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L74))

### Memory

Agent long-term memory: recall, remember, forget, and enable/disable.

```ts
/** Agent long-term memory: recall, remember, forget, and enable/disable. */
export effectSet Memory = <std::memory::recall, std::memory::remember, std::memory::forget, std::memory::enableMemory, std::memory::disableMemory>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L77))

### NotesRead

Read-only Notes access: reading, searching, and listing.

```ts
/** Read-only Notes access: reading, searching, and listing. */
export effectSet NotesRead = <std::notes::read, std::notes::search, std::notes::list>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L80))

### NotesWrite

Notes mutation: creating, appending, and deleting.

```ts
/** Notes mutation: creating, appending, and deleting. */
export effectSet NotesWrite = <std::notes::create, std::notes::append, std::notes::delete>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L83))

### Notes

All Notes access, reads and writes.

```ts
/** All Notes access, reads and writes. */
export effectSet Notes = <NotesRead, NotesWrite>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/effectSets.agency#L86))
