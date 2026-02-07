# How the statestack class works

## Params
- `this.stack`: an array containing the state of every frame in the stack.
  For each frame, it tracks the local variables, the arguments to the function
  or node, and what line the execution is currently on.
- `this.globals`: keeps track of any global variables. 
- `this.other`: this is where we store interrupt data. This could be better named.

## More on global state
Note that since every agency file has its own state stack.
This means that we will only be tracking variables global to *that file*.
This should be fine since nodes and functions can't and shouldn't be able
to access global variables from other files.

But it does mean that when we restore state,
it's important to restore THE STATE STACK OF THE CORRECT FILE,
so that global variables are set correctly!

This is why we don't restore the `__stateStack` and `__global` variables right here.
Instead we run the correct node and pass the StateStack into that node,
so that the *node* can restore the global state, thus ensuring it will restore those values
to the `__stateStack` and `__global` variables local to its file.
This means you can import and call the `approveInterrupt` and `rejectInterrupt`
functions from ANY file, and as long as the nodes of that file are part of the same graph,
the state will get restored correctly. You don't need to keep track of which node the interrupt
is being returned from. You don't need to make sure you import the `rejectInterrupt`
from that file. Any one will do.

## Serialization and deserialization
### Serialization
All the state for a function or node is being tracked in one of the frames of the stack.
When you create a function like this, for example:

```
def greet(name: string):
    greeting = "Hello, ${name}!"
    return greeting
```

the generated TypeScript code will look similar to this:

```function greet(name: string): string {
  const __stack = __stateStack.getNewState();
  const __self = __stack.locals;
  const __args = __stack.args;

  save arguments to the stack
  __args["name"] = name;

  function body
  __self.greeting = `Hello, ${__args.name}!`;

  return __self.greeting;
}
```

Those variables are in fact not local to that function. They are being set on a stack frame. This means when we need to save the current execution state and return to the user due to an interrupt, the state was being tracked on a single object named `__stateStack`, so we just need to JSON stringify that object and return it to the user.

### Deserialization
I already explained above how we restore the state inside a graph node to ensure that the global state is being set correctly. But how do we restore the state local to each function or node? Well, suppose the initial flow went like this:

```
- node sayHi
    - greet("Alice")
        - interrupt
```

We started at a node `sayHi`, we called a function `greet` and the `greet` function returned an interrupt. At this point, the stack looks something like this:

```
["<state for sayHi>", "<state for greet>"]
```

Notice that no matter what node or function you're in, *the state for that node or function is the last object in the stack*. That way, if that node or function calls another function, that function's state will get appended to the end, and we get this nice stack functionality where we can push and pop frames on and off.

Now, when we restore state, we'll be starting at the node `sayHi`. We want to restore the state, so we shift it off the stack:

```
"<state for sayHi>" <-- ["<state for sayHi>", "<state for greet>"]

// new stack:
["<state for greet>"]
```


Since we're currently in the `sayHi` node, the state for this node needs to be the last object on the stack! So we shift the state off the stack and immediately append it to the end of the stack:

```
// shifting off
"<state for sayHi>" <-- ["<state for sayHi>", "<state for greet>"]

// new stack:
["<state for greet>"]

// pushing back on
["<state for greet>"] <-- "<state for sayHi>"

// new stack:
["<state for greet>", "<state for sayHi>"]
```

From here, we'll be going straight to the function greet and again the same thing will happen.

```
// shifting off
"<state for greet>" <-- ["<state for greet>", "<state for sayHi>"]

// new stack:
["<state for sayHi>"]

// pushing back on
["<state for sayHi>"] <-- "<state for greet>"

// new stack:
["<state for sayHi>", "<state for greet>"]
```

That's a funny roundtrip we took! But, this allowed us to restore state to this function or node, since its state is tracked in the last frame, and the last frame now contains the restored state.

What if the create function calls a new function `foo` that wasn't previously on our stack? Now we need to make sure we no longer do this funny round trip and we just push a new frame onto the stack for `foo`:

```
// new stack for foo:
["<state for greet>", "<state for sayHi>"] <-- ["<state for foo>"]

// new stack:
["<state for greet>", "<state for sayHi>", "<state for foo>"]
```

How do we know when to change this behavior? This is where the `deserializeStackLength` variable comes in. Every time we're in deserialize mode and we shift a frame off the stack, we decrement `deserializeStackLength`. Once `deserializeStackLength` is at zero, we know all state has been restored and we no longer need to shift frames off.
