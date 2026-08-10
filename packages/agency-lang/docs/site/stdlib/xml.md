---
name: "xml"
description: "Parse XML into a tree of plain objects and pull values out of it."
---

# xml

Parse XML into a tree of plain objects and pull values out of it. Built for
  feed-like documents (RSS, Atom, sitemaps, API responses), not for XML
  conformance validation.

  `parseXml` returns a `Result<XmlDocument>`: a failure carries a message with
  line and column, so a bad document tells you what went wrong and where. The
  helpers (`xmlFind`, `xmlFindAll`, `xmlText`, `xmlAttr`) cover most needs
  without walking the tree by hand:

  ```ts
  import { parseXml, xmlFindAll, xmlFind, xmlText, xmlAttr } from "std::xml"

  node main() {
    const doc = parseXml("<feed><entry><title>Hi</title><link href='https://a'/></entry></feed>") catch null
    if (doc == null) {
      return
    }
    for (entry in xmlFindAll(doc.root, "entry")) {
      print(xmlText(xmlFind(entry, "title")))
      print(xmlAttr(xmlFind(entry, "link"), "href"))
    }
  }
  ```

  Scope and limitations:
  - Namespaces are not resolved. A name like `media:thumbnail` is matched as
    that literal string, and `xmlns` attributes are ordinary attributes.
  - DTDs are not supported: a DOCTYPE without an internal subset is skipped;
    custom entity definitions are a parse failure.
  - The five predefined entities (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`)
    and numeric character references are decoded. A bare `&` that starts no
    valid reference is kept as a literal ampersand, because real-world feeds
    ship unescaped ampersands in URLs; every other malformed construct fails
    loudly with a position.
  - Fixed safety limits: input up to 10 MiB (UTF-8 bytes), element nesting up
    to 256 deep, and up to 250,000 tree entries (elements + attributes + text
    nodes). Documents beyond these fail to parse.
  - Whitespace is preserved: whitespace-only text nodes are kept and text is
    never trimmed. CRLF and lone CR newlines are normalized to LF.

## Types

### XmlText

A run of character data. Adjacent text, decoded references, and CDATA
  content are coalesced into one node.

```ts
/** A run of character data. Adjacent text, decoded references, and CDATA
  content are coalesced into one node. */
export type XmlText = {
  kind: "text";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L47))

### XmlElement

An element: literal tag name (namespace prefixes included), attributes,
  and children in document order.

```ts
/** An element: literal tag name (namespace prefixes included), attributes,
  and children in document order. */
export type XmlElement = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L54))

### XmlNode

A tree node: match on `kind` to tell elements from text.

```ts
/** A tree node: match on `kind` to tell elements from text. */
export type XmlNode = XmlElement | XmlText
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L62))

### XmlDocument

A parsed document. The root is always an element.

```ts
/** A parsed document. The root is always an element. */
export type XmlDocument = {
  root: XmlElement
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L65))

## Functions

### parseXml

```ts
parseXml(xml: string): Result<XmlDocument>
```

Parse an XML string into a document tree. Fails with a line/column message
  on malformed input, so use catch or match to handle bad documents.

  @param xml - The XML source text

**Parameters:**

| Name | Type | Default |
|---|---|---|
| xml | `string` |  |

**Returns:** `Result<XmlDocument>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L69))

### xmlFind

```ts
xmlFind(node: XmlNode | null, tag: string): XmlElement | null
```

Find the first descendant element with the given tag (depth-first, document
  order), or null if there is none. Accepts null so lookups chain without
  null checks.

  @param node - The node to search under (the node itself is not a candidate)
  @param tag - The literal tag name to find, including any namespace prefix

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | `XmlNode \| null` |  |
| tag | `string` |  |

**Returns:** `XmlElement | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L79))

### xmlFindAll

```ts
xmlFindAll(node: XmlNode | null, tag: string): XmlElement[]
```

Find every descendant element with the given tag, in document order.
  Returns an empty list when the node is null or nothing matches.

  @param node - The node to search under (the node itself is not a candidate)
  @param tag - The literal tag name to find, including any namespace prefix

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | `XmlNode \| null` |  |
| tag | `string` |  |

**Returns:** `XmlElement[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L91))

### xmlText

```ts
xmlText(node: XmlNode | null): string
```

The text content of a node and all of its descendants, concatenated in
  document order. Returns an empty string for null, so it composes directly
  with xmlFind. Text is never trimmed.

  @param node - The node to read text from

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | `XmlNode \| null` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L102))

### xmlAttr

```ts
xmlAttr(node: XmlElement | null, name: string): string | null
```

Read an attribute value from an element. Returns null when the attribute
  is missing or the element is null, and an empty string when the attribute
  is present but empty.

  @param node - The element to read from
  @param name - The literal attribute name, including any namespace prefix

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | `XmlElement \| null` |  |
| name | `string` |  |

**Returns:** `string | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/xml.agency#L113))
