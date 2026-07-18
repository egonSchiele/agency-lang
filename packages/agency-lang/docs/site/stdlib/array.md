---
name: "array"
description: "Re-exports the array helpers (`map`, `filter`, `reduce`, and friends) so that `import { map, filter, ... } from std::array` keeps working. These helpers now live in `std::index` and are auto-imported into every `.agency` file, so you rarely need to import them at all."
---

# array

Re-exports the array helpers (`map`, `filter`, `reduce`, and friends) so
that `import { map, filter, ... } from "std::array"` keeps working. These
helpers now live in `std::index` and are auto-imported into every
`.agency` file, so you rarely need to import them at all.
