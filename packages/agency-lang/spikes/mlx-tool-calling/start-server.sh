#!/bin/bash
# Start mlx_lm.server on one of the downloaded MLX models.
#
#   ./start-server.sh                                  # Qwen3-Coder-Next, port 8080
#   ./start-server.sh mlx-community/DeepSeek-V4-Flash-4bit
#   PORT=8081 ./start-server.sh ...
#
# Leave this running in its own terminal. The model loads once and stays in
# memory until you stop the server with ctrl-c.
set -euo pipefail

MODEL="${1:-mlx-community/Qwen3-Coder-Next-4bit}"
PORT="${PORT:-8080}"
VENV="${MLX_VENV:-$HOME/mlx-env}"

# The weights live under HF_HOME on the external SSD. Same value as
# ~/download-models.sh, so huggingface_hub finds the downloaded snapshot
# instead of downloading it again.
export HF_HOME="${HF_HOME:-/Volumes/Models/hf}"
export HF_HUB_OFFLINE=1

if [ ! -d "$HF_HOME" ]; then
  echo "HF_HOME=$HF_HOME does not exist. Is the SSD mounted?" >&2
  exit 1
fi
if [ ! -x "$VENV/bin/mlx_lm.server" ]; then
  echo "No mlx_lm.server in $VENV. Create the env first (see the plan, task 1)." >&2
  exit 1
fi

# --max-tokens: the server's default is 512 and applies whenever a request
# does not set max_tokens. Agency does not, so without this every long reply
# gets cut off mid-sentence and looks like a model problem.
exec "$VENV/bin/mlx_lm.server" \
  --model "$MODEL" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --max-tokens 16384 \
  --log-level INFO
