---
name: "capabilities"
---

# capabilities

Standard **capability** effect sets — named groups of the interrupt
  effects the standard library raises, for use in `raises` clauses.

  A `raises` clause is an *allowlist* (an upper bound), so these sets are
  composable building blocks you union together to say what a function or
  node is permitted to do:

  ```ts
  import { FileRead, Network } from "std::capabilities"

  // may read files and make network calls — nothing else
  node main() raises <FileRead, Network> { ... }

  // read-only inspection
  node audit() raises <FileRead> { ... }

  // guaranteed to perform no interrupting actions
  def pure() raises <> { ... }
  ```

  The sets are purely mechanical groupings by capability; they encode no
  security judgement (e.g. there is intentionally no "read-only" set that
  decides whether a network fetch counts as a read). Compose the pieces
  you need.

  Note: these constrain callers. Individual functions should still declare
  the specific effect they raise (e.g. `raises <std::read>`), not a whole
  capability set.

## Types

### FileRead

Read-only filesystem access: reading files and listing/searching paths.

```ts
/** Read-only filesystem access: reading files and listing/searching paths. */
export effectSet FileRead = <std::read, std::readBinary, std::ls, std::glob, std::grep>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L33))

### FileWrite

Filesystem mutation: creating, editing, moving, copying, and deleting.

```ts
/** Filesystem mutation: creating, editing, moving, copying, and deleting. */
export effectSet FileWrite = <std::write, std::writeBinary, std::edit, std::applyPatch, std::mkdir, std::move, std::copy, std::remove>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L36))

### FileSystem

All filesystem access — reads and writes.

```ts
/** All filesystem access — reads and writes. */
export effectSet FileSystem = <FileRead, FileWrite>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L39))

### Shell

Arbitrary command / process execution. The sharpest edge — grant with care.

```ts
/** Arbitrary command / process execution. The sharpest edge — grant with care. */
export effectSet Shell = <std::bash, std::exec, std::run>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L42))

### Network

Anything that talks to the outside world over the network.

```ts
/** Anything that talks to the outside world over the network. */
export effectSet Network = <std::http::fetch, std::http::fetchJSON, std::http::fetchMarkdown, std::search, std::tavilySearch, std::weather, std::browserUse, std::wikipedia::article, std::wikipedia::search, std::wikipedia::summary, std::gdelt, std::fred, std::dbnomics, std::edgar, std::littlesis, std::yc, std::hackernews, std::wikidata, std::usaspending>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L45))

### DataFinance

The std::data/finance connectors (news + macro + filings). Each also raises
    std::http::fetchJSON, which is covered by the broader Network set.

```ts
/** The std::data/finance connectors (news + macro + filings). Each also raises
    std::http::fetchJSON, which is covered by the broader Network set. */
export effectSet DataFinance = <std::gdelt, std::fred, std::edgar, std::dbnomics>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L49))

### Messaging

Sending messages to people: email, SMS, and iMessage.

```ts
/** Sending messages to people: email, SMS, and iMessage. */
export effectSet Messaging = <std::sendEmail, std::sendSms, std::sendIMessage>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L52))

### Secrets

Reading and writing credentials in the system keyring.

```ts
/** Reading and writing credentials in the system keyring. */
export effectSet Secrets = <std::getSecret, std::setSecret, std::deleteSecret>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L55))

### Auth

OAuth-style authorization flows: granting, fetching, and revoking access.

```ts
/** OAuth-style authorization flows: granting, fetching, and revoking access. */
export effectSet Auth = <std::authorize, std::getAccessToken, std::revokeAuth>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L58))

### Calendar

Calendar access: listing and mutating events (incl. calendar authorization).

```ts
/** Calendar access: listing and mutating events (incl. calendar authorization). */
export effectSet Calendar = <std::listEvents, std::createEvent, std::updateEvent, std::deleteEvent, std::authorizeCalendar>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L61))

### Memory

Agent long-term memory: recall, remember, forget, and enable/disable.

```ts
/** Agent long-term memory: recall, remember, forget, and enable/disable. */
export effectSet Memory = <std::memory::recall, std::memory::remember, std::memory::forget, std::memory::enableMemory, std::memory::disableMemory>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/capabilities.agency#L64))
