# index

## Installation

```
npm install @agency-lang/web-fetch
```

## Usage

```ts
import { fetchPage } from "pkg::@agency-lang/web-fetch"

node main() {
  const page = fetchPage("https://example.com")
  print(page.title)
  print(page.content)
}
```

## Functions

### fetchPage

```ts
fetchPage(url: string, maxChars: number, timeout: number)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` |  |
| maxChars | `number` | 20000 |
| timeout | `number` | 15000 |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/web-fetch/index.agency#L23))
