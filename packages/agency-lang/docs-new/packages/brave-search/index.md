# index

## Installation

```
npm install @agency-lang/brave-search
```

## Environment Variables

Set `BRAVE_API_KEY` to your Brave Search API key. Alternatively, you can pass the key directly via the `apiKey` parameter.

## Usage

```
import { braveSearch } from "pkg::@agency-lang/brave-search"

node main() {
  const results = braveSearch("agency language programming")
  print(results)
}
```

## Functions

### braveSearch

```ts
braveSearch(query: string, count: number, apiKey: string, country: string, searchLang: string, safesearch: string, freshness: string)
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| count | `number` | 5 |
| apiKey | `string` | "" |
| country | `string` | "" |
| searchLang | `string` | "" |
| safesearch | `string` | "" |
| freshness | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/brave-search/index.agency#L26))
