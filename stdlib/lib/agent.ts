export type TodoStatus = "pending" | "in_progress" | "completed";

export type Todo = {
  id: string;
  text: string;
  status: TodoStatus;
};

let _todos: Todo[] = [];

function normalizeStatus(status: unknown): TodoStatus {
  if (
    status === "pending" ||
    status === "in_progress" ||
    status === "completed"
  ) {
    return status;
  }
  return "pending";
}

export function _todoWrite(todos: Todo[]): Todo[] {
  _todos = todos.map((t) => ({
    id: String(t.id),
    text: String(t.text),
    status: normalizeStatus(t.status),
  }));
  return _todos;
}

export function _todoList(): Todo[] {
  return _todos;
}
