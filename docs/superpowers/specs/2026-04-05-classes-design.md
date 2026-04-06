# Classes in Agency — Design Spec

## Overview

Add object-oriented programming to Agency via a `class` keyword that supports fields, constructors, methods, mutation, single inheritance, and serialization. Classes compile to TypeScript classes with auto-generated `toJSON()`/`fromJSON()` methods for interrupt serialization.

## Syntax

### Basic class

```
class User {
  name: string
  age: number

  greet(): string {
    return "Hi, I'm " + this.name
  }
}

let user = new User("Alice", 30)
user.greet()
user.age = 31
```

When no constructor is defined, a default constructor is generated that takes one argument per field in declaration order and assigns each one. The above is equivalent to writing:

```
class User {
  name: string
  age: number

  constructor(name: string, age: number) {
    this.name = name
    this.age = age
  }

  greet(): string {
    return "Hi, I'm " + this.name
  }
}
```

### Custom constructor

An explicit constructor is only needed when custom initialization logic is required:

```
class User {
  name: string
  age: number
  displayName: string

  constructor(name: string, age: number) {
    this.name = name
    this.age = age
    this.displayName = name + " (" + age + ")"
  }
}
```

### Inheritance

```
class Admin extends User {
  role: string

  constructor(name: string, age: number, role: string) {
    super(name, age)
    this.role = role
  }

  describe(): string {
    return this.name + " is a " + this.role
  }
}

let admin = new Admin("Bob", 25, "superadmin")
admin.greet()
admin.describe()
```

For subclasses, the default constructor (when none is provided) takes arguments for all fields — parent fields first in declaration order, then own fields — and calls `super(...)` with the parent fields:

```
class Admin extends User {
  role: string

  describe(): string {
    return this.name + " is a " + this.role
  }
}

// Default constructor is equivalent to:
// constructor(name: string, age: number, role: string) {
//   super(name, age)
//   this.role = role
// }
```

### Method overriding

```
class Admin extends User {
  role: string

  greet(): string {
    return "Hi, I'm " + this.name + " (" + this.role + ")"
  }
}
```

Overriding methods must have a compatible signature: same parameter types and a compatible return type.

## Syntax Details

- **`class` keyword** introduces a class definition.
- **Fields** are declared with `name: type` at the top of the class body.
- **`constructor(...)`** optionally defines how instances are created. If omitted, a default constructor is generated that takes one argument per field in declaration order and assigns each one. For subclasses, the default constructor takes parent fields first, then own fields, and calls `super(...)` with the parent fields.
- **Methods** use `methodName(params): returnType { body }` syntax — no `fn` keyword.
- **`this`** is implicitly available in all methods and the constructor. It refers to the current instance. It compiles directly to TypeScript's `this`.
- **`new ClassName(...)`** creates instances.
- **`extends`** enables single inheritance. Only one parent class is allowed.
- **`super(...)`** calls the parent constructor from within a subclass constructor.
- Fields are mutable: `obj.field = value` and `this.field = value` both work.

## Compilation

Agency classes compile to TypeScript classes with a near 1:1 mapping. `this` in Agency is `this` in TypeScript. Inheritance compiles to `extends`. Auto-generated `toJSON()` and `fromJSON()` methods are added for serialization. If no constructor is defined, a default constructor is generated.

### Example: User

```typescript
class User {
  name: string;
  age: number;

  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }

  greet(): string {
    return "Hi, I'm " + this.name;
  }

  toJSON(): object {
    return {
      __class: "moduleId::User",
      name: this.name,
      age: this.age,
    };
  }

  static fromJSON(data: any): User {
    const instance = Object.create(User.prototype);
    instance.name = data.name;
    instance.age = data.age;
    return instance;
  }
}
```

### Example: Admin (subclass)

```typescript
class Admin extends User {
  role: string;

  constructor(name: string, age: number, role: string) {
    super(name, age);
    this.role = role;
  }

  describe(): string {
    return this.name + " is a " + this.role;
  }

  greet(): string {
    return "Hi, I'm " + this.name + " (" + this.role + ")";
  }

  toJSON(): object {
    return {
      ...super.toJSON(),
      __class: "moduleId::Admin",
      role: this.role,
    };
  }

  static fromJSON(data: any): Admin {
    const instance = Object.create(Admin.prototype);
    instance.name = data.name;
    instance.age = data.age;
    instance.role = data.role;
    return instance;
  }
}
```

### Key compilation details

- `this` in Agency maps directly to `this` in TypeScript — no translation needed.
- `super(...)` in constructor → `super(...)` in TS.
- `toJSON()` serializes all fields plus a `__class` discriminator string.
- Subclass `toJSON()` spreads `super.toJSON()` and overrides `__class`.
- `fromJSON()` is a static method that reconstructs an instance via `Object.create(Class.prototype)` and direct field assignment. This avoids re-running constructor side effects during deserialization and eliminates the need to map constructor parameter names to field names. For subclasses, `fromJSON` must assign **all** fields including inherited ones (the code generator walks the inheritance chain to collect the full field list).
- `__class` is namespaced with the module ID to avoid collisions: `"moduleId::ClassName"` (e.g., `"main::User"`, `"auth::User"`).

## Runtime Integration

### Class registry

The `RuntimeContext` gets a new field:

```typescript
classRegistry: Record<string, { fromJSON: (data: any) => any }>
```

Each compiled file registers its classes at module initialization:

```typescript
__ctx.registerClass("moduleId::User", User);
__ctx.registerClass("moduleId::Admin", Admin);
```

### Class registry lifetime

The `classRegistry` is **shared** across execution contexts (like `graph`), not freshly created (like `globals`). When `createExecutionContext()` creates a child context, it copies the parent's `classRegistry` reference. This ensures class deserialization works when resuming from an interrupt, which always goes through `createExecutionContext`.

### Serialization

**Serialization side:** `JSON.stringify` automatically calls `toJSON()` on class instances, so `StateStack` and `GlobalStore` serialization work without changes. The `deepClone` function (`JSON.parse(JSON.stringify(...))`) used throughout the serialization path will convert class instances to plain tagged objects (with `__class`), which is expected.

**Deserialization side:** The reviver is applied at the **top-level `JSON.parse` call** where serialized interrupt state is first parsed back from a string (in the interrupt resumption path). This is the single point where `JSON.parse(serializedString, reviver)` is called. Since `JSON.parse` with a reviver processes bottom-up, all nested class instances are reconstructed before their containing objects. By the time `State.fromJSON()` and `GlobalStore.fromJSON()` receive their data, class instances are already fully reconstructed — no changes needed to those methods.

The reviver is created with access to the `classRegistry` from `RuntimeContext`, which is available at the top-level deserialization call site:

```typescript
function createClassReviver(classRegistry: ClassRegistry) {
  return function reviver(key: string, value: any): any {
    if (value && typeof value === "object" && "__class" in value) {
      const cls = classRegistry[value.__class];
      if (cls) return cls.fromJSON(value);
    }
    return value;
  };
}
```

This handles all cases: nested class instances (e.g., a `User` field containing an `Address`), arrays of class instances (e.g., `User[]`), and deeply nested structures — all revived correctly due to the bottom-up processing.

### Execution isolation

Class definitions are shared across all calls (like functions). They are not copied per-call. Instances live in variables and follow normal Agency scoping rules (global, local, shared, etc.).

Class instances in `shared` variables are **not** serialized/deserialized — they persist across calls and retain their prototype chain naturally. Only instances in global and local variables go through the `toJSON`/`fromJSON` cycle during interrupts.

## Classes as Tool/Function Parameters

When a class is used as a parameter type for a function (tool), the Zod schema is generated from the class's fields only (methods are excluded). This is the same schema generation used for type aliases.

For `User`, the schema would be:

```typescript
z.object({
  name: z.string(),
  age: z.number(),
})
```

When the LLM returns JSON matching this schema, the runtime reconstructs a class instance before passing it to the function. This happens in the runtime's tool-call handling code (not in per-function generated code), keeping it centralized and maintainable.

The runtime uses the parameter's type annotation to determine which class to instantiate. When the type checker marks a parameter as a class type, the generated code includes metadata mapping that parameter name to its class name. The runtime looks up the class in the `classRegistry` and calls `fromJSON()` on the LLM's JSON output. This means the function receives an object with working methods.

Note: the Zod schema does not include the `__class` discriminator, since the LLM doesn't know about it. The class is determined from the parameter type, not from the data.

## Type Checking

The type checker must support:

- **Class types:** A class name is a valid type annotation (e.g., `let user: User`). Class type information flows into the type checker via `ProgramInfo`, which will store class definitions (fields, methods, constructor signature, parent class) alongside existing type alias and function definition maps.
- **Field access:** Validate that accessed fields exist on the class (including inherited fields).
- **Method calls:** Validate that called methods exist, with correct argument types and return type.
- **Constructor validation:** `new ClassName(...)` checks argument count and types against the constructor signature.
- **Inheritance:** Subclass types are assignable to parent class types. Inherited fields and methods are visible on the subclass. Field name shadowing across inheritance is **not allowed** — the type checker rejects subclasses that redeclare a parent field.
- **Method overriding:** Overriding methods must have compatible signatures (same parameter types, compatible return type).
- **`this` type:** Inside methods and the constructor, `this` has the type of the enclosing class.
- **Method return types:** Return types on methods are required (not inferred) in v1, consistent with the explicit syntax `methodName(): returnType { ... }`.

## TypeScript Interop

- Agency classes compile to real TS classes and work naturally when passed to TypeScript code.
- TypeScript classes **cannot** be imported or used in Agency code. Agency has no way to know their field/method signatures for type checking, and no way to serialize/deserialize them.
- TypeScript objects that are instances of TS classes **cannot** be used in Agency code for the same serialization reasons.
- Plain TypeScript objects (not class instances) can still be used in Agency as they are today.
- There is no automatic conversion from plain objects to Agency class instances. Use the constructor explicitly.

## In Scope (v1)

- `class` keyword with fields, constructor, and methods
- Single inheritance with `extends` and `super()`
- Method overriding with signature compatibility checks
- `this` as instance reference (matches TypeScript directly)
- Default constructor generated from field declarations when none is provided
- `new ClassName(...)` construction
- Mutable fields
- Serialization via `toJSON()`/`fromJSON()` with class registry
- Type checking for fields, methods, constructors, inheritance
- Classes usable as type annotations
- Classes as tool/function parameter types (Zod schema from fields, `fromJSON` for instance construction)

## Out of Scope (v1)

- Interfaces / abstract classes
- Access modifiers (`public`/`private`/`protected`)
- Static methods/fields
- Generics on classes
- Importing or using TypeScript classes in Agency
- Importing or using TypeScript class instances in Agency
- Automatic conversion from plain objects to class instances
- Circular references between class instances (will error at serialization time)
- Schema evolution (changing class fields between serialization and deserialization)
- `instanceof` operator (natural follow-up, but not in v1)
