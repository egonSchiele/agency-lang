export type DoorRequest = { method: string; path: string; body: Record<string, unknown> };
export type Refusal = { status: number; message: string };
export type Prepared = { body: Record<string, unknown> } | { refusal: Refusal };
export type AllowedRoute = { method: string; path: string };
export type PartCheck = (part: Record<string, unknown>) => string | null;
export type FieldMove = { from: string; to: string };
export type RequestRules = {
  routes: AllowedRoute[];
  parts: Record<string, PartCheck>;
  moved: FieldMove[];
  refused: string[];
};

export function anyPart(): null {
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function dataImagePart(part: Record<string, unknown>): string | null {
  const image = part.image_url;
  if (isObject(image) && typeof image.url === "string" && image.url.startsWith("data:image/")) {
    return null;
  }
  return 'An image must be sent as a data:image/ URI. This server does not fetch URLs or open file paths. In Agency code, image("photo.png") sends the file\'s bytes.';
}

function routeRefusal(rules: RequestRules, request: DoorRequest): Refusal | null {
  if (
    rules.routes.some((route) => route.method === request.method && route.path === request.path)
  ) {
    return null;
  }
  const allowed = rules.routes.map((route) => `${route.method} ${route.path}`).join(", ");
  return {
    status: 404,
    message: `This model answers only ${allowed}. This request was ${request.method} ${request.path}.`,
  };
}

function partsRefusal(rules: RequestRules, body: Record<string, unknown>): Refusal | null {
  if (body.messages === undefined) {
    return null;
  }
  if (!Array.isArray(body.messages)) {
    return { status: 400, message: "messages must be an array." };
  }
  for (const message of body.messages) {
    if (!isObject(message)) {
      return { status: 400, message: "Each message must be an object." };
    }
    if (
      message.content === null ||
      message.content === undefined ||
      typeof message.content === "string"
    ) {
      continue;
    }
    if (!Array.isArray(message.content)) {
      return { status: 400, message: "Message content must be text or an array of parts." };
    }
    for (const part of message.content) {
      const type = isObject(part) && typeof part.type === "string" ? part.type : "(missing)";
      const check = Object.hasOwn(rules.parts, type) ? rules.parts[type] : undefined;
      if (check === undefined) {
        return {
          status: 400,
          message: `A message part of type ${type} is not accepted. Accepted: ${Object.keys(rules.parts).join(", ")}.`,
        };
      }
      const reason = check(part);
      if (reason !== null) {
        return { status: 400, message: reason };
      }
    }
  }
  return null;
}

/** Copy the fields being changed; never mutate the caller's request. */
function moveFields(body: Record<string, unknown>, moves: FieldMove[]): Prepared {
  const result = { ...body };
  for (const move of moves) {
    const [parent, child] = move.from.split(".");
    const container = child === undefined ? result : result[parent];
    const key = child ?? parent;
    if (!isObject(container) || !Object.hasOwn(container, key)) {
      continue;
    }
    if (Object.hasOwn(result, move.to) && result[move.to] !== container[key]) {
      return {
        refusal: { status: 400, message: `Conflicting fields ${move.from} and ${move.to}.` },
      };
    }
    result[move.to] = container[key];
    if (child === undefined) {
      delete result[parent];
    } else {
      const remaining = { ...container };
      delete remaining[child];
      if (Object.keys(remaining).length === 0) {
        delete result[parent];
      } else {
        result[parent] = remaining;
      }
    }
  }
  return { body: result };
}

function fieldRefusal(rules: RequestRules, body: Record<string, unknown>): Refusal | null {
  const field = rules.refused.find((key) => Object.hasOwn(body, key));
  return field === undefined
    ? null
    : {
        status: 400,
        message: `The field ${field} is not supported by the server for this model.`,
      };
}

/** Validate the route and message parts, move fields, then reject unsupported fields. */
export function applyRequestRules(rules: RequestRules, request: DoorRequest): Prepared {
  const refusal = routeRefusal(rules, request) ?? partsRefusal(rules, request.body);
  if (refusal !== null) {
    return { refusal };
  }
  const moved = moveFields(request.body, rules.moved);
  if ("refusal" in moved) {
    return moved;
  }
  const unsupported = fieldRefusal(rules, moved.body);
  return unsupported === null ? moved : { refusal: unsupported };
}
