import { AgencyNode, Expression } from "../types.js";
import { BaseNode } from "./base.js";
import { ArrayPattern, ObjectPattern } from "./pattern.js";

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
  itemVar: string | ObjectPattern | ArrayPattern;
  indexVar?: string;
  iterable: Expression;
  body: AgencyNode[];
};
