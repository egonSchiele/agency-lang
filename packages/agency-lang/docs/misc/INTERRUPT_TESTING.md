# Interrupt Testing Guide

This document describes the interrupt testing functionality added to the Agency language test system.

## Overview

The Agency testing framework now supports programmatic testing of interrupts. You can define test cases that specify how interrupts should be handled (approve, reject, or modify) without requiring manual user input.

## Test Case Structure

Test cases are defined in `.test.json` files with the following structure:

```json
{
  "sourceFile": "path/to/file.agency",
  "tests": [
    {
      "nodeName": "nodeName",
      "input": "arguments as string",
      "expectedOutput": "expected result as JSON string",
      "evaluationCriteria": [
        { "type": "exact" }
      ],
      "interruptHandlers": [
        {
          "action": "approve",
          "expectedMessage": "optional message to validate",
          "modifiedArgs": { "optional": "for modify action" }
        }
      ]
    }
  ]
}
```

### InterruptHandler Fields

Each interrupt handler in the `interruptHandlers` array can have:

- **`action`** (required): One of:
  - `"approve"` - Approve the interrupt and continue execution
  - `"reject"` - Reject the interrupt
  - `"modify"` - Approve with modified arguments

- **`expectedMessage`** (optional): If provided, validates that the interrupt message matches this value. Test fails if it doesn't match.

- **`modifiedArgs`** (optional): For `"modify"` action, provides new arguments as a JSON object.

## Example

Given an Agency file `example.agency`:

```agency
def dangerousOperation(action: string) {
  return interrupt("About to perform: " + action)
  return "Operation completed: " + action
}

node main(action: string) {
  result = dangerousOperation(action)
  return result
}
```

Create a test file `example.test.json`:

```json
{
  "sourceFile": "example.agency",
  "tests": [
    {
      "nodeName": "main",
      "input": "\"delete database\"",
      "expectedOutput": "\"Operation completed: delete database\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        {
          "action": "approve",
          "expectedMessage": "About to perform: delete database"
        }
      ]
    },
    {
      "nodeName": "main",
      "input": "\"delete database\"",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        {
          "action": "reject",
          "expectedMessage": "About to perform: delete database"
        }
      ]
    },
    {
      "nodeName": "main",
      "input": "\"delete database\"",
      "expectedOutput": "\"Operation completed: backup database\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        {
          "action": "modify",
          "modifiedArgs": { "action": "backup database" },
          "expectedMessage": "About to perform: delete database"
        }
      ]
    }
  ]
}
```

## Running Tests

Run tests with the `test` command:

```bash
agency test example.test.json
```

## Creating Test Fixtures Interactively

Use the `fixtures` command to interactively create test cases:

```bash
agency fixtures example.agency
```

or

```bash
agency fixtures example.agency:main
```

### Interactive Interrupt Handling

When you run `agency fixtures`, if the execution encounters an interrupt:

1. The interrupt message will be displayed
2. You'll be prompted to choose how to handle it:
   - Approve
   - Reject
   - Modify arguments (you'll be prompted for new args as JSON)
3. The interrupt handler will be saved to the test case
4. Execution continues to check for additional interrupts
5. Once all interrupts are handled, you'll see the final output

## Validation

The test framework validates:

1. **Interrupt count**: If you provide more handlers than interrupts occur, the test fails
2. **Missing handlers**: If an interrupt occurs but no handler is provided, the test fails
3. **Message matching**: If `expectedMessage` is specified, the actual interrupt message must match exactly

## Implementation Details

### Files Modified

1. **`lib/cli/test.ts`**:
   - Added `InterruptHandler` type
   - Updated `TestCase` type to include optional `interruptHandlers` field
   - Modified `fixtures()` to interactively handle interrupts
   - Modified `test()` to pass interrupt handlers to execution
   - Updated `writeTestCase()` to save interrupt handlers

2. **`lib/cli/util.ts`**:
   - Modified `executeNode()` to accept optional `interruptHandlers` parameter
   - Passes handlers to the evaluate template

3. **`lib/templates/cli/evaluate.mustache`**:
   - Added interrupt handling loop
   - Imports `isInterrupt`, `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`
   - Validates interrupt messages against `expectedMessage`
   - Applies handlers in sequence
   - Throws errors for mismatches or missing handlers

4. **`lib/cli/evaluate.ts`**:
   - Updated `executeNode()` call to pass `undefined` for interrupt handlers

## Multiple Interrupts

The system supports multiple sequential interrupts. Handlers are applied in the order they appear in the `interruptHandlers` array:

```json
{
  "interruptHandlers": [
    {
      "action": "approve",
      "expectedMessage": "First interrupt"
    },
    {
      "action": "reject",
      "expectedMessage": "Second interrupt"
    },
    {
      "action": "modify",
      "modifiedArgs": { "param": "new value" },
      "expectedMessage": "Third interrupt"
    }
  ]
}
```

## Error Messages

- **Unexpected interrupt**: `"Unexpected interrupt #N: \"message\". No handler provided."`
- **Too many handlers**: `"Expected N interrupts but only M occurred."`
- **Message mismatch**:
  ```
  Interrupt #N message mismatch.
    Expected: "expected message"
    Actual: "actual message"
  ```
