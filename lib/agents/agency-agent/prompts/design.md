### Phase 2: Design
Goal. Design an implementation approach using the agency language. In this phase, you will sketch out the high-level abstractions based on the user's intent. You will be given an overall goal and an array of desired actions. You will then go through the following steps.

**IMPORTANT: All the examples of code below should be modified to fit your specific use case. For example, if the user wants to build a meal planning app, customize the categorization enum and prompt to be about reminders.**

## Step 1: User input
The first step to building this agent will be to have it collect user input. Write some code like this:

```agency
node main() {
  print("Welcome to the agent!")
  userMsg = input("How may I help you? ")
}
```

Every agent file needs a node named `main` if it will be run directly. This node defines the entry point into the agent. First, the agent should print a welcome message that relates to the overall goal that the user provided you. Next, the agent should collect some user input using the input function.

## Step 2: Build a categorization node
After collecting user input, we need to figure out which of the desired actions the user wants to take. You will first need to write an enum for all the desired actions. For example, if the user wants to create a todo list app, the enum might look something like this:

```agency
type Category = "add-todo" | "delete-todo" | "edit-todo" | "mark-todo-done";
```

Next, you'll need to write a prompt that can take the user's input message and categorize it into one of the values in this enum. Here's an example of what the prompt might look like:

```agency
categorizePrompt = """
If you are a master at categorization, the user is going to give you some text relating to to-dos. Take this user input, and classify their intent into one of these categories:

- If the user wants to add their to-do to their to-do list, return "add-todo"
- If the user wants to delete a to-do from their to-do list, return "delete-todo"
- If the user wants to edit a to-do in their to-do list, return "edit-todo"
- If the user wants to mark a to-do as done, return "mark-todo-done"
Here is the user input: ${userMsg}
"""
```

Note the use of three quotation marks to denote a multi-line string.

Finally, you'll need to call this prompt and store the resulting category in a variable. It should look something like this:

```agency
category: Category = llm("${categorizePrompt}")
```

Notice how I have added a type hint to the `category` variable with the `Category` enum we created above. This is an important part of the code as it instructs the LLM call to only return a value in our category enum.

Put all this categorization code in a new node and call the node from the main node. Your code will look something like this.

```agency
node main() {
  print("Welcome to the agent!")
  userMsg = input("How may I help you? ")
  return categorize(userMsg)
}

node categorize(userMsg: string) {
  categorizePrompt = """
  If you are a master at categorization, the user is going to give you some text relating to to-dos. Take this user input, and classify their intent into one of these categories:

  - If the user wants to add their to-do to their to-do list, return "add-todo"
  - If the user wants to delete a to-do from their to-do list, return "delete-todo"
  - If the user wants to edit a to-do in their to-do list, return "edit-todo"
  - If the user wants to mark a to-do as done, return "mark-todo-done"
  Here is the user input: ${userMsg}
  """
  category: Category = llm("${categorizePrompt}")  
}
```

Important: Notice how the main node **returns** the call to the categorized node. This is important. Calls to another node must always be returned because moving to another node marks a state transition. Unlike functions, nodes never return back to their caller. They mark a permanent shift in the execution flow of the code.

## Step 3: Build out the nodes for each category
After categorizing the user's intent, you need to now create nodes for each action. After categorizing the user intent, you will call one of these action nodes. For our to-do list app, the action nodes might look something like this.

```agency
node addTodo() {
  print("Adding a to-do!")
  // more code here
}

node deleteTodo() {
  print("Deleting a to-do!")
  // more code here
}

node editTodo() {
  print("Editing a to-do!")
  // more code here
}

node markTodoDone() {
  print("Marking a to-do as done!")
  // more code here
}
```

Then use a `match` statement to direct the user to the correct node based on category:

```agency
match (category) {
  "add-todo" => return addTodo()
  "delete-todo" => return deleteTodo()
  "edit-todo" => return editTodo()
  "mark-todo-done" => return markTodoDone()
}
```

Put the match statement in the `categorize` node right after you get the category from the LLM call.

## Step 4: User feedback and iteration
After you have built out the nodes for each category, show the code to the user and ask for their feedback.

IMPORTANT!! Show only the code! Print the code using the `printCode` tool so that it shows with syntax highlighting. Do not print any additional text besides the code.

IMPORTANT! Remember to ALWAYS use the `printCode` tool when showing code to the user so that the code prints with syntax highlighting.

If they have any changes, make the changes and show it to them again. Repeat this process until they confirm that the design looks good to them.

## Response types
Please make sure your answers, your responses conform to this format.

```
type DesignAction = { type: "askUser"; question: string } | { type: "done"; finalCode: string }
```

If you need to ask the user a follow-up question, respond with

```
{ type: "askUser", question: "your question here" }
``` 
 
If you are done, respond with the written code as a string in the `finalCode` field like this:

```
{ type: "done", finalCode: "your final code here" }
```

