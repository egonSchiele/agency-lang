#!/bin/bash
# Raw protocol check, no Agency involved: send one chat completion with a
# tools array and print the response. If this does not come back with a
# tool_calls entry, nothing above it can work, and the problem is the server
# or the model, not Agency or smoltalk.
#
#   ./curl-tools.sh                    # port 8080
#   PORT=8000 ./curl-tools.sh          # e.g. mlx-openai-server
set -euo pipefail

PORT="${PORT:-8080}"
MODEL="${1:-mlx-community/Qwen3-Coder-Next-4bit}"

curl -sS "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer unused" \
  -d @- <<EOF | python3 -m json.tool
{
  "model": "$MODEL",
  "messages": [
    { "role": "user", "content": "What is 17 + 25? You must use the add tool. Reply with just the number." }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "add",
        "description": "Add two numbers.",
        "parameters": {
          "type": "object",
          "properties": {
            "a": { "type": "number" },
            "b": { "type": "number" }
          },
          "required": ["a", "b"]
        }
      }
    }
  ],
  "temperature": 0,
  "max_tokens": 512
}
EOF
