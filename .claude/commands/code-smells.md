Review your changes for code smells:

- multiple braces in a row
- Too much imperative code, not enough declarative code. Declarative code lets programmers say exactly what their intention is and is easier to read. All imperative code should be clearly encapsulated and isolated, and expose a nice declarative abstraction that the user can use.
- functions > 100 lines
- files > 1000 lines
- lots of mutable state
- variables need to be set in just the right order
- leaky abstractions -- To understand this code, you need to read a lot of different code because it's all connected.
- parallel mutable vars - this is a sign that the data structure isn't quite right. If you have to maintain two separate mutable records that are updated in sync, it's easy to mess up and get them out of sync. It's better to store the related data together in a single record or object.
- complex types that use lots of primitives with no semantic meaning (e.g. Record<string, Record<string, string[]>>) -- if you have a complex type like this, it's a sign that you should probably be defining a new type with a descriptive name to make it clearer what the data represents.

Example:

Smell:  
```  
Record<string, Record<string, string[]>> is hard to read
```

Fix: Name the intermediate type:

```
type PersonName = string;
type Relationships = Record<PersonName, PersonName[]>;  // funcName -> kinds

type SocialCircle = string;
type InterruptKindsByFile = Record<SocialCircle, Relationships>;
```
