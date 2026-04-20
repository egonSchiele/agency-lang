# Agency CLI
To get the most up-to-date information on the Agency CLI, you should run `agency --help`, but here is some information on some common commands you may want to run:

- Compile an agency file: `agency compile file.agency`
- Compile an agency file as TypeScript: `agency compile file.agency --ts`
- Run an agency file: `agency run file.agency` or simply `agency file.agency`
- Debug an agency file: `agency debug file.agency`
- Enable watch mode on a single file: `agency compile file.agency --watch`
- Enable watch mode on a directory: `agency compile dir/ --watch`
- Run a file and create a single trace: `agency run file.agency --trace`

Note: If you want to automatically generate a trace for every run, you can use the [traceDir configuration option](/guide/traces-and-bundles).