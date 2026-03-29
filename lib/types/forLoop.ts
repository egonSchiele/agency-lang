import { AgencyNode, Expression } from "../types.js";
import { BaseNode } from "./base.js";

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

export type ForLoop = BaseNode & {
  type: "forLoop";
  itemVar: string;
  indexVar?: string;
  iterable: Expression;
  body: AgencyNode[];
};
