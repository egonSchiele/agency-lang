# The Agency debugger
Agency has a very good built-in debugger. Lets try using it. Put the following code in a file called `test.agency`:

```ts
node main() {
 const name = "world"
 const greeting = llm("Say hello to ${name}!")
 print(greeting)
}
```

and then invoke the debugger using

```
agency debug test.agency
```

Here are some things you may want to do with the debugger: 

- Step forward: Press `s` or the down arrow. 
- Continue until you hit a `debugger` statement: Press `c` or `space`. 
- Rewind or step backwards: Press the up arrow, or press `r` to see a list of checkpoints. Press up/down to scroll and you'll see the line each checkpoint is for.
- Override the value of a variable: Enter `:set varName=newValue`. Then when you press `s`, the next statement will execute with the variable's value overwritten.
- Cycle between all the different panels: `tab` and `shift+tab`. Once a panel has focus, you can press the up or down arrow keys to scroll, or press `z` to zoom, temporarily making that panel full screen. 
- In the threads panel, you can press `[` or `]` to cycle between the different threads.