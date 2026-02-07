# Agency
Agent Definition Language

## Usage

Add agency to a project:

```bash
pnpm add agency-lang
```

You can then start using the agency script on your files:

```bash
# to compile
agency compile infile.agency outfile.ts

# to compile and run
agency run infile.agency

# or simply
agency infile.agency
```

Note that the generated files use several other libraries that you will need to install as well:

```bash
pnpm i nanoid openai piemachine statelog-client zod
```

## troubleshooting
### Weird undefined error

A couple of times, I have tried to import a parser, and even though it exists, when I import it, the value that is `undefined`. This is due to a circular dependency issue. If I move that parser to its own file and then import it, it works.

## License
[FSL](https://fsl.software).