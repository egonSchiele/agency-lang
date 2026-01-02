# ADL
Agent Definition Language

## troubleshooting
### Weird undefined error

A couple of times, I have tried to import a parser, and even though it exists, when I import it, the value that is `undefined`. This is due to a circular dependency issue. If I move that parser to its own file and then import it, it works.