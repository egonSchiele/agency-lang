# TypeScript Type Extraction with ts-morph

## Overview

This document outlines how to implement automatic type extraction from imported TypeScript functions using ts-morph, eliminating the need for manual agency function wrappers.

## Problem Statement

Currently, when importing TypeScript functions into Agency, you must manually wrap them to specify type signatures:

```agency
import {getSummary, getHtml} from "./wikipedia.ts"

def wikipediaSummary(page: string): string {
  """
  Fetches a summary for a given Wikipedia page
  """
  return getSummary(page)
}
```

The wrapper's purpose is to:
1. Specify parameter names/types (`page: string`)
2. Specify return type (`: string`)
3. Provide a description for the tool
4. Generate a tool definition like `__wikipediaSummaryTool`

## Proposed Solution

Use ts-morph to automatically extract type information from TypeScript files, generating tool definitions without manual wrappers.

## What is ts-morph?

ts-morph is a wrapper around the TypeScript Compiler API that makes it easier to programmatically analyze and manipulate TypeScript code. It can:

- Parse TypeScript files and extract type information
- Read function signatures (parameters, types, return types)
- Extract JSDoc comments
- Resolve type aliases and complex types

## Implementation Plan

### Step 1: Install ts-morph

```bash
pnpm add ts-morph
```

### Step 2: Create Type Extraction Utility

Create `lib/utils/typeExtractor.ts`:

```typescript
import { Project, FunctionDeclaration, ParameterDeclaration, SyntaxKind } from "ts-morph";

export interface ExtractedFunction {
  name: string;
  parameters: Array<{
    name: string;
    type: string;
    isOptional: boolean;
  }>;
  returnType: string;
  description?: string;
  isAsync: boolean;
}

export class TypeScriptTypeExtractor {
  private project: Project;

  constructor(tsConfigPath?: string) {
    this.project = new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Extract function type information from a TypeScript file
   */
  extractFunctionInfo(
    filePath: string,
    functionNames: string[]
  ): Map<string, ExtractedFunction> {
    const sourceFile = this.project.addSourceFileAtPath(filePath);
    const result = new Map<string, ExtractedFunction>();

    for (const functionName of functionNames) {
      // Try to find as a function declaration
      let funcDecl = sourceFile.getFunction(functionName);

      // Try to find as a variable with function type
      if (!funcDecl) {
        const variable = sourceFile.getVariableDeclaration(functionName);
        if (variable) {
          // Handle arrow functions and function expressions
          const initializer = variable.getInitializer();
          if (initializer && (initializer.isKind(SyntaxKind.ArrowFunction) ||
                             initializer.isKind(SyntaxKind.FunctionExpression))) {
            funcDecl = initializer as any;
          }
        }
      }

      if (funcDecl) {
        result.set(functionName, this.extractFromFunction(funcDecl));
      }
    }

    return result;
  }

  private extractFromFunction(func: FunctionDeclaration): ExtractedFunction {
    const parameters = func.getParameters().map((param) => ({
      name: param.getName(),
      type: this.getParameterType(param),
      isOptional: param.isOptional(),
    }));

    const returnType = this.getReturnType(func);
    const description = this.extractDescription(func);
    const isAsync = func.isAsync();

    return {
      name: func.getName() || "anonymous",
      parameters,
      returnType,
      description,
      isAsync,
    };
  }

  private getParameterType(param: ParameterDeclaration): string {
    const typeNode = param.getTypeNode();
    if (typeNode) {
      return typeNode.getText();
    }
    // Fallback to inferred type
    return param.getType().getText();
  }

  private getReturnType(func: FunctionDeclaration): string {
    const returnTypeNode = func.getReturnTypeNode();
    if (returnTypeNode) {
      let typeText = returnTypeNode.getText();
      // Unwrap Promise<T> to get T
      const promiseMatch = typeText.match(/^Promise<(.+)>$/);
      if (promiseMatch) {
        return promiseMatch[1];
      }
      return typeText;
    }
    // Fallback to inferred return type
    const type = func.getReturnType();
    let typeText = type.getText();
    // Unwrap Promise<T>
    const promiseMatch = typeText.match(/^Promise<(.+)>$/);
    if (promiseMatch) {
      return promiseMatch[1];
    }
    return typeText;
  }

  private extractDescription(func: FunctionDeclaration): string | undefined {
    const jsDocs = func.getJsDocs();
    if (jsDocs.length > 0) {
      return jsDocs[0].getDescription().trim();
    }
    return undefined;
  }
}
```

### Step 3: Modify Import Statement Processing

Update `lib/backends/typescriptGenerator.ts` to use ts-morph when processing import statements:

```typescript
import { TypeScriptTypeExtractor, ExtractedFunction } from "../utils/typeExtractor.js";
import path from "path";

class TypeScriptGenerator extends BaseGenerator {
  private typeExtractor: TypeScriptTypeExtractor;
  private extractedFunctions: Map<string, ExtractedFunction> = new Map();
  private baseDir: string; // Directory of the agency file being processed

  constructor(program: AgencyProgram, baseDir: string) {
    super(program);
    this.baseDir = baseDir;
    this.typeExtractor = new TypeScriptTypeExtractor();
  }

  protected processImportStatement(node: ImportStatement): string {
    // Parse the import to extract function names
    // e.g., "import {foo, bar} from './file.ts'"
    const importedNames = this.parseImportedNames(node.importedNames);

    // Resolve the file path relative to the agency file
    const tsFilePath = this.resolveImportPath(node.modulePath);

    // Extract type information using ts-morph
    const extractedFuncs = this.typeExtractor.extractFunctionInfo(
      tsFilePath,
      importedNames
    );

    // Store for later use when generating tools
    for (const [name, info] of extractedFuncs) {
      this.extractedFunctions.set(name, info);
    }

    // Generate both the import statement AND auto-generated tool wrappers
    const importStatement = `import ${node.importedNames} from "${node.modulePath}";`;
    const toolWrappers = this.generateAutoToolWrappers(extractedFuncs);

    return importStatement + "\n" + toolWrappers;
  }

  private generateAutoToolWrappers(
    funcs: Map<string, ExtractedFunction>
  ): string {
    const wrappers: string[] = [];

    for (const [name, info] of funcs) {
      // Generate a tool definition
      const toolName = `__${name}Tool`;
      const schemaFields = info.parameters
        .map((p) => `${p.name}: ${this.mapTypeToZodSchema(p.type)}`)
        .join(", ");

      const toolDef = `
export const ${toolName} = {
  name: "${name}",
  description: ${JSON.stringify(info.description || `Calls ${name}`)},
  schema: z.object({${schemaFields}})
};`;

      wrappers.push(toolDef);
    }

    return wrappers.join("\n\n");
  }

  private mapTypeToZodSchema(tsType: string): string {
    // Map TypeScript types to Zod schemas
    // Start with basic types, expand over time
    switch (tsType) {
      case "string": return "z.string()";
      case "number": return "z.number()";
      case "boolean": return "z.boolean()";
      case "any": return "z.any()";
      default:
        // Handle arrays
        if (tsType.endsWith("[]")) {
          const innerType = tsType.slice(0, -2);
          return `z.array(${this.mapTypeToZodSchema(innerType)})`;
        }
        // Handle Array<T> syntax
        const arrayMatch = tsType.match(/^Array<(.+)>$/);
        if (arrayMatch) {
          return `z.array(${this.mapTypeToZodSchema(arrayMatch[1])})`;
        }
        // Handle Promise (shouldn't happen after unwrapping, but just in case)
        if (tsType.startsWith("Promise<")) {
          return "z.any()"; // fallback
        }
        // For unknown/complex types, default to z.any()
        console.warn(`Unknown type: ${tsType}, defaulting to z.any()`);
        return "z.any()";
    }
  }

  private parseImportedNames(importClause: string): string[] {
    // Parse various import formats:
    // "{ foo, bar }" -> ["foo", "bar"]
    // "* as name" -> needs different handling
    // "default" -> needs different handling

    // Handle named imports: { foo, bar }
    const namedMatch = importClause.match(/\{\s*([^}]+)\s*\}/);
    if (namedMatch) {
      return namedMatch[1].split(",").map(s => s.trim());
    }

    // Handle namespace imports: * as name
    const namespaceMatch = importClause.match(/\*\s+as\s+(\w+)/);
    if (namespaceMatch) {
      // For namespace imports, we'd need to handle differently
      // This might require tracking the namespace and looking up member access
      return [];
    }

    // Handle default imports
    const defaultMatch = importClause.trim().match(/^(\w+)$/);
    if (defaultMatch) {
      return [defaultMatch[1]];
    }

    return [];
  }

  private resolveImportPath(modulePath: string): string {
    // Resolve relative paths relative to the agency file being processed
    if (modulePath.startsWith(".")) {
      return path.resolve(this.baseDir, modulePath);
    }
    // For absolute paths or node_modules, return as-is
    return modulePath;
  }
}
```

### Step 4: Update Generator Instantiation

Make sure to pass the base directory when creating the generator:

```typescript
// In lib/backends/typescriptGenerator.ts or wherever the generator is created
const agencyFileDir = path.dirname(agencyFilePath);
const generator = new TypeScriptGenerator(program, agencyFileDir);
```

## Usage Example

After implementation, users could write:

```agency
import {getSummary, getHtml} from "./wikipedia.ts"

node research(msg) {
  +getSummary  // Automatically knows: (page: string) => string
  +getHtml     // Automatically knows: (page: string) => string
  answer = `Research this: ${msg}`
  return answer
}
```

The system would:
1. Parse the import statement
2. Use ts-morph to open `wikipedia.ts`
3. Extract `getSummary` and `getHtml` signatures
4. Automatically generate `__getSummaryTool` and `__getHtmlTool` with correct schemas
5. Make them available for use with the `+` operator

## Key Benefits

1. **No manual wrappers needed** - Just import and use
2. **Type safety** - Automatically extracts correct types from TypeScript
3. **Descriptions from JSDoc** - Can pull function documentation automatically
4. **Handles complex types** - Can resolve type aliases, unions, etc. (with additional work)
5. **Async detection** - Automatically knows if a function is async
6. **Less boilerplate** - Reduces code duplication and maintenance burden

## Challenges to Consider

### 1. Complex Types
Mapping all TypeScript types to Zod schemas can be complex:
- **Generics**: `Array<T>`, `Record<K, V>`, custom generic types
- **Unions**: `string | number` needs to map to `z.union([z.string(), z.number()])`
- **Intersections**: `A & B` needs special handling
- **Custom types**: Type aliases and interfaces from other files
- **Enums**: Need to map to `z.enum()` or `z.nativeEnum()`

**Solution**: Start with basic types and gradually expand. For complex types, fall back to `z.any()` with a warning.

### 2. Description Quality
Auto-generated descriptions from JSDoc might not be as good as hand-written ones for tool usage.

**Solution**: Allow manual override with a new syntax like:
```agency
import {getSummary} from "./wikipedia.ts"
describe getSummary as "Fetches a comprehensive summary for any Wikipedia page"
```

### 3. Error Handling
Need good error messages when:
- TypeScript file doesn't exist
- Function isn't found in the file
- Function isn't exported
- Types can't be resolved

**Solution**: Add comprehensive error handling with helpful messages.

### 4. Performance
ts-morph adds some overhead as it needs to parse and type-check TypeScript files.

**Solution**:
- Cache extraction results
- Only extract when files change
- Consider making it optional with a flag

### 5. Type Resolution
Some types might be imported from other files and require full type checking.

**Solution**: Configure ts-morph with the project's tsconfig.json for full type resolution.

### 6. Multiple Export Formats
Functions can be exported in various ways:
```typescript
export function foo() {}           // Named export
export const bar = () => {}        // Arrow function export
export default function baz() {}   // Default export
export { qux }                     // Re-export
```

**Solution**: Handle each export format in the type extractor.

## Implementation Phases

### Phase 1: Basic Implementation
- Install ts-morph
- Create basic type extractor for simple function declarations
- Handle string, number, boolean types
- Generate tool definitions from extracted signatures

### Phase 2: Enhanced Type Support
- Add support for arrays
- Handle async functions properly
- Extract JSDoc descriptions
- Add error handling

### Phase 3: Advanced Features
- Support complex types (unions, intersections, generics)
- Handle multiple export formats
- Add caching for performance
- Support namespace imports

### Phase 4: Polish
- Add manual description override syntax
- Improve error messages
- Add tests for edge cases
- Document the feature

## Testing Strategy

Create test files that cover:
1. Simple function exports
2. Arrow function exports
3. Functions with various parameter types
4. Functions with JSDoc comments
5. Async functions
6. Functions with complex types
7. Error cases (missing files, missing functions)

## Alternative: Hybrid Approach

Allow both manual and automatic modes:

```agency
// Automatic extraction
import {getSummary} from "./wikipedia.ts"

// Manual wrapper when needed
import {complexFunction} from "./complex.ts"
def complexFunctionTool(param: CustomType): Result {
  """Custom description"""
  return complexFunction(param)
}
```

This gives users flexibility while reducing boilerplate for simple cases.

## Conclusion

This feature would significantly improve the developer experience by eliminating manual wrapper functions for TypeScript imports. The implementation is feasible using ts-morph, and the benefits outweigh the complexity. Start with basic types and gradually expand support for more complex scenarios.
