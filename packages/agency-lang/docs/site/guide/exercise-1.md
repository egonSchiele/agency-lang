---
name: Exercise 1
description: Practice exercises for getting familiar with Agency's syntax and features.
---

# Exercise 1

You're ready to write your first Agency program! Write a program that will search Wikipedia for a topic.

Hints:
- Check out [common functions](/guide/common-functions) to see how to take user input.
- Use functions from the [standard library](/stdlib/wikipedia) to search Wikipedia.
- The `search` function will raise an interrupt. Use `with approve` to approve it.

The answer is listed below!

## Answer

```ts
import { search } from "std::wikipedia"

def searchWikipedia(query: string) {
  const results = search(query) with approve
  return results
}

node main() {
  const query = input("Enter a search query: ")
  const results = llm("Search Wikipedia for: ${query}", tools: [searchWikipedia])
  print(results)
}
```