Review your changes for code smells:

- multiple braces in a row
- Too much imperative code, not enough declarative code. Declarative code lets programmers say exactly what their intention is and is easier to read. All imperative code should be clearly encapsulated and isolated, and expose a nice declarative abstraction that the user can use.
- functions > 100 lines
- files > 1000 lines
- lots of mutable state
- variables need to be set in just the right order
- leaky abstractions -- To understand this code, you need to read a lot of different code because it's all connected.
