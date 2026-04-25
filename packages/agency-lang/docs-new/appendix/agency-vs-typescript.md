# Agency vs TypeScript
Because Agency compiles to TypeScript, it has many similarities, but some things are different.

There are some [syntactical differences](/guide/basic-syntax). For example, Agency does not have ternary operators and it only has two types of loop: a while loop and an iterative for loop. Besides that, though, there are some bigger differences. Agency adds a lot of features to TypeScript, and that's the focus of the [Agency guide](/guide/getting-started). But here are some TypeScript features that it does not have.

- No destructuring syntax
- Agency's type system is not as powerful as the TypeScript type system. In particular, it doesn't have generics right now
- No classes
- Agency has first-class functions, but it does not have lambdas. Instead, it has [blocks](/guide/blocks).