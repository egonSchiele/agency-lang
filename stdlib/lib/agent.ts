export type TodoStatus = "pending" | "in_progress" | "completed";

export type Todo = {
  id: string;
  text: string;
  status: TodoStatus;
};

let _todos: Todo[] = [];

export function _todoWrite(todos: Todo[]): Todo[] {
  _todos = todos.map((t) => ({
    id: String(t.id),
    text: String(t.text),
    status: (t.status ?? "pending") as TodoStatus,
  }));
  return _todos;
}

export function _todoList(): Todo[] {
  return _todos;
}
