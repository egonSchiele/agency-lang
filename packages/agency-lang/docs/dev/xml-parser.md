# The XML parser (`std::xml`)

## Why this exists

Reddit shut off its unauthenticated JSON endpoints in May 2026 and gated the
official API behind a manual approval process. What still works — verified
empirically — is Reddit's RSS output, and RSS covers far more than Reddit:
local news sites, blogs, and Mastodon all publish feeds. The plan is a generic
RSS connector with a thin Reddit layer on top, and the missing capability was
XML parsing: the connector stack is JSON-native (`connectorFetch` wraps
`fetchJSON`), and RSS/Atom are XML.

Rather than adding a third-party XML dependency, the parser is written with
tarsec, the parser combinator library that powers every other parser in this
repo. It lives in `lib/stdlib/xml/` with a bridge at `lib/stdlib/xml.ts`, and
is exposed to Agency programs as `std::xml`. The full design history is in the
spec (`2026-08-10-xml-parser-spec.md` in the package root, untracked).

## The documented subset

This is not a conforming XML processor; it is a parser for a documented
subset — the XML that feeds actually contain — that fails loudly with a
line/column message on everything outside the subset. The grammar:

```text
document := BOM? XMLDecl? Misc* Doctype? Misc* element Misc* EOF
Misc     := XML-whitespace | comment | processing-instruction
content  := text | CDATA | comment | processing-instruction | element
```

Key rules, all tested in `lib/stdlib/xml/grammar.test.ts`:

- Exactly one root element. Declarations only at the start; at most one
  DOCTYPE, before the root, quote-aware, with internal subsets (`[...]`)
  rejected. CDATA only inside elements. Comments cannot contain `--`.
- Names are ASCII (`[:A-Za-z_][:A-Za-z0-9_.-]*`). Namespaces are never
  resolved: `media:thumbnail` is a literal tag name, `xmlns` is a literal
  attribute. All three captured feed fixtures (Reddit Atom, NPR RSS 2.0,
  Mastodon RSS) use only ASCII names — that scan is why the grammar can be
  this simple.
- Duplicate attributes fail. Attribute dictionaries are created with
  `Object.create(null)`, so `__proto__` and friends are inert data.
- CRLF and lone CR are normalized to LF **once, up front**, so tarsec
  positions, entity-decoder offsets, and output text share one coordinate
  system. Never normalize per-value; that drifts error positions.
- **The one recovery rule**: a bare `&` that starts no valid reference is a
  literal ampersand. Real feeds ship unescaped ampersands in URLs; rejecting
  the whole feed over one URL would defeat the purpose. Everything else about
  references is strict: the five predefined entities exact-case, numeric
  references validated against the XML character ranges by our own range
  check (never by letting `String.fromCodePoint` throw), unknown named
  entities fail naming the entity, and decoding is one-pass (`&amp;lt;` is
  the four characters `&lt;`).
- All text is preserved: whitespace-only text nodes are kept (dropping them
  corrupts mixed content — `<b>Hello</b> <i>world</i>` must not become
  `Helloworld`), nothing is trimmed, and adjacent text/CDATA/reference
  contributions coalesce into one text node.

## The tree and the helpers

Plain serializable objects: `XmlNode = XmlElement | XmlText` (tagged union on
`kind`), `XmlDocument = { root: XmlElement }`. The recursive union crosses
the Agency boundary as-is — no untyped `children`. Four helpers carry the
ergonomics (`xmlFind`, `xmlFindAll`, `xmlText`, `xmlAttr`): descendant-only
search (never the supplied node), pre-order depth-first, null-tolerant so
lookups chain (`xmlText(xmlFind(entry, "title"))`), never trimming, never
prefix-stripping. There is deliberately no query language.

## Limits (measured, not guessed)

All fixed constants in `lib/stdlib/xml/types.ts`; every violation is an
ordinary parse failure, never a thrown exception:

- `MAX_INPUT_BYTES` = 10 MiB of UTF-8, checked before parsing.
- `MAX_DEPTH` = 256 (root is depth 1). The spike measured the uncapped
  combinator stack overflowing near nesting ~2,100, so 256 keeps roughly an
  8x margin.
- `MAX_TREE_ENTRIES` = 250,000, counting elements, attributes, and retained
  text nodes (merging into an existing text node is free). Measured basis:
  hostile tiny-element input allocates ~420 bytes of heap per entry, so the
  cap bounds a worst-case parse near ~105 MB transient heap while still
  admitting a 10 MiB feed-like document (~177k entries at ~1 KB/item).

A performance trap to keep out of the hot path: computing a line/column
(`lineColOf`) is an O(offset) scan. It was once called on every successful
close tag and turned a 3 MB hostile parse from ~120 ms into 88 seconds.
Position formatting belongs on failure paths only.

## The tarsec execution contract

- The entry point runs the whole parse through `runNested`, with a wrapper
  parser that calls `getErrorMessage()` **inside** the callback — the nested
  state (and its registered committed failure) is gone once `runNested`
  returns. Parsing is fully synchronous.
- Structural failures go through one helper (`DocumentParse.fail`) that
  creates a `committedFailure` whose `rest` is a suffix of the normalized
  source at the error offset, and registers it in
  `getParseState().committedFailure` — the same thing tarsec's `committed()`
  combinator does, which is why `getErrorMessage()` prefers it and formats
  the `Line X, col Y:` prefix.
- Depth and entry counters live in a per-invocation `DocumentParse` instance,
  never module globals. Depth is restored in `finally`.
- One tarsec API gotcha: `takeWhile1`/`compileCharPredicate` predicates
  receive **UTF-16 code units (numbers)**, not one-character strings.
  `(c) => c !== "<"` is always true.

## Testing layout

- `lib/stdlib/xml/*.test.ts` carry the weight: grammar, entities (every
  malformed-reference partition), failure quality (messages assert construct
  names AND exact `Line X, col Y`), limits on both sides of each boundary,
  hostile inputs (unterminated everything, every prefix of a representative
  document — nothing may throw), and a nested-tarsec-state regression.
- `lib/stdlib/xml/testFixtures/` holds two captured feeds (Reddit Atom, NPR
  RSS 2.0) and one constructed sloppy feed pinning the bare-ampersand rule.
  `fixtures.test.ts` opens with a hygiene test: no raw controls, no
  `feed=`/`user=` query parameters (Reddit personal feed tokens are bearer
  credentials, and Reddit echoes the request URL into the feed's `<id>` —
  capture fixtures WITHOUT the token), no URL userinfo, no token-ish params.
- `tests/agency/xml/` proves only the boundary: the recursive union in
  generated code, `Result<XmlDocument>` + `catch`, and that the bridge
  preserves the exact error text with no `Error:` prefix (the bridge throws
  `new Error(coreError)`; Agency's `try` converts it — the parseAST pattern
  from `stdlib/agency.agency`).

## What layers on top

The RSS connector (separate spec): fetch feed text, `parseXml`, normalize
RSS 2.0 vs Atom into a flat item type, plus a thin Reddit layer building
`.rss` URLs with the user's feed-token query parameters (redacted like
presigned URLs). This module stays pure — no I/O, no effects, no interrupts.
