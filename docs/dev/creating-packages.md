# Creating New Agency Packages

## Overview

Agency packages are npm packages that include `.agency` source files alongside compiled `.js` output. They let Agency users import functions using the `pkg::` prefix. Existing packages live in `packages/` at the repo root.

## Reference Implementation

Use `packages/brave-search/` as the canonical reference. It's a minimal, well-structured example.

## Directory Structure

```
packages/<package-name>/
  src/
    <implementation>.ts        # Core logic (TypeScript)
    <implementation>.test.ts   # Unit tests (vitest, mock external calls)
  tests/
    agency/
      <test>.agency            # Agency integration test
  dist/                        # Built output (gitignored)
  index.agency                 # Agency entrypoint - thin wrapper over TS impl
  index.js                     # Compiled output of index.agency (committed)
  package.json
  tsconfig.json
  makefile
```

## package.json Template

```json
{
  "name": "@agency-lang/<package-name>",
  "version": "0.0.1",
  "description": "<Description> integration for Agency",
  "type": "module",
  "agency": "./index.agency",
  "main": "./index.js",
  "exports": {
    ".": {
      "types": "./dist/src/<implementation>.d.ts",
      "import": "./dist/src/<implementation>.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist/",
    "index.agency",
    "index.js"
  ],
  "author": "Aditya Bhargava",
  "license": "ISC",
  "bugs": { "url": "https://github.com/egonSchiele/agency-lang/issues" },
  "homepage": "https://github.com/egonSchiele/agency-lang",
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "test:run": "vitest run",
    "test:agency": "agency tests/agency"
  },
  "peerDependencies": {
    "agency-lang": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

Add any runtime dependencies (e.g., the third-party SDK) to `dependencies`.

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests", "src/**/*.test.ts"]
}
```

## makefile

```makefile
all:
	pnpm run build

publish:
	npm publish --access public --no-git-checks
```

## index.agency Pattern

The `.agency` file is a thin wrapper that:
1. Imports the TypeScript implementation from `./dist/src/<impl>.js`
2. Exports Agency functions with doc comments (used as tool descriptions)
3. Uses default parameters so Agency users get a simple API
4. Passes options through to the TS implementation

```agency
/**
## Installation

\`\`\`
npm install @agency-lang/<package-name>
\`\`\`

## Environment Variables

Set `<ENV_VAR>` to your API key. Alternatively, pass the key directly via the `apiKey` parameter.

## Usage

\`\`\`ts
import { myFunction } from "pkg::@agency-lang/<package-name>"

node main() {
  const results = myFunction("some input")
  print(results)
}
\`\`\`
*/

import { myFunction as myFunctionImpl } from "./dist/src/<impl>.js"

/// Description of what this function does (sent to LLM as tool description).
export def myFunction(input: string, optionalParam: string = "", apiKey: string = "") {
  return myFunctionImpl(input, {
    optionalParam: optionalParam,
    apiKey: apiKey
  })
}
```

Key conventions:
- The top-level doc comment (`/** */`) provides package-level documentation
- Use `///` (triple-slash) for function-level doc comments - these become tool descriptions
- Use `export def` to make functions importable by users
- Use empty string defaults for optional string params (Agency doesn't have `undefined`)
- The TS implementation should use `||` (not `??`) to fall through empty strings to env vars

## TypeScript Implementation Pattern

```typescript
const API_URL = "https://api.example.com/v1/endpoint";

export type MyResult = {
  // typed fields
};

export type MyOptions = {
  apiKey?: string;
  // other optional config
};

export async function myFunction(
  input: string,
  options?: MyOptions
): Promise<MyResult> {
  const apiKey = options?.apiKey || process.env.MY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing API key. Set MY_API_KEY env var or pass apiKey option."
    );
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input, ...options }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  // Map to typed result
  return data;
}
```

## Testing Pattern

### Unit tests (src/<impl>.test.ts)
- Mock `globalThis.fetch` to avoid real API calls
- Test URL construction, headers, parameter mapping, error handling
- Use vitest with `vi.fn().mockResolvedValue(...)` for mock responses

### Agency integration tests (tests/agency/<test>.agency)
- Import from the package's index.agency: `import { fn } from "../../index.agency"`
- These make real API calls - keep them minimal
- Run with `pnpm run test:agency`

## Compiling index.agency to index.js

The `index.js` file is the compiled output of `index.agency` and must be committed. To generate it:

```bash
cd packages/agency-lang
pnpm run compile ../brave-search/index.agency
```

This outputs the compiled JS. Redirect to `index.js` in the package directory. The compiled file is large and full of runtime boilerplate - don't edit it by hand.

## How Users Import the Package

From Agency code:
```ts
import { myFunction } from "pkg::@agency-lang/<package-name>"
```

From TypeScript code (importing the TS implementation directly):
```ts
import { myFunction } from "@agency-lang/<package-name>"
```

## Checklist for Creating a New Package

1. Create `packages/<name>/` directory
2. Create `package.json` (use template above, add SDK dependency)
3. Create `tsconfig.json` (copy from brave-search)
4. Create `makefile` (copy from brave-search)
5. Write `src/<impl>.ts` - the core TypeScript implementation
6. Write `src/<impl>.test.ts` - unit tests with mocked fetch
7. Write `index.agency` - thin Agency wrapper with doc comments
8. Run `pnpm install` from repo root to link workspace deps
9. Run `pnpm run build` in the package to compile TS
10. Compile `index.agency` to `index.js` (see command above)
11. Write `tests/agency/<test>.agency` - integration test
12. Add the package to the root `pnpm-workspace.yaml` if needed
