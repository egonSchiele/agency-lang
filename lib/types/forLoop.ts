import { AgencyNode, FunctionCall, Literal } from "../types.js";
import { ValueAccess } from "./access.js";

/*
eg
```
for (item in items)
```
item - itemVar
items - iterable

```
for (item, index in items)
```
item - itemVar
index - indexVar
items - iterable

*/

export type ForLoop = {
  type: "forLoop";
  itemVar: string;
  indexVar?: string;
  iterable: ValueAccess | FunctionCall | Literal;
  body: AgencyNode[];
};
