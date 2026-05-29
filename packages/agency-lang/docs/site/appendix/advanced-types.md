---
title: Advanced types
description: Notes on advanced type usage in Agency, including the intentionally-unsound covariance of `Record<K, V>` in both type parameters and the tradeoffs that motivated the choice.
---

# Advanced types
This page adds some more notes on advanced type usage.

## Covariance, invariance
Agency treats `Record<K, V>` as **covariant** in both type parameters. Covariance means narrow values can flow into wider Records — e.g. `Record<string, "approve">` is assignable to `Record<string, string>`. Makes sense, right? If you have an object with type `Record<string, "approve">`, Of course, it should be assignable to type `Record<string, string>`... `"approve"` is strictly a subset of string.

The problem comes when users mutate the object.

```ts
let narrow: Record<string, "approve"> = { alice: "approve" }

// makes sense
let wide: Record<string, string> = narrow

// oops! This is fine for the `Record<string, string>` type,
// but it also mutates `narrow`, and `narrow` can't have `"anything"` as a value.
// It can only have approve!
wide["bob"] = "anything"
```

So this is a case the type checker isn't going to catch. I made this decision intentionally because it feels so obvious that a type `Record<string, "approve">` should be assignable to type `Record<string, string>`... `"approve"`, and I think it will trip a lot of users up if isn't that way. It makes the type checker slightly unsound, but I think for the vast majority of cases this is more intuitive and correct.