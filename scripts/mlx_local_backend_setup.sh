#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${REPO_ROOT}/.venv-mlx"
PYTHON_BIN="${VENV_DIR}/bin/python"
ENV_PATH="${REPO_ROOT}/.env"
MLX_MODEL_DEFAULT="${TRICHAT_MLX_MODEL_DEFAULT:-mlx-community/Qwen2.5-Coder-3B-Instruct-4bit}"
MLX_ENDPOINT_DEFAULT="${TRICHAT_MLX_ENDPOINT_DEFAULT:-http://127.0.0.1:8788}"

/opt/homebrew/bin/python3 -m venv "${VENV_DIR}"
"${PYTHON_BIN}" -m pip install -U pip setuptools wheel
"${PYTHON_BIN}" -m pip install -U mlx mlx-lm

"${PYTHON_BIN}" - <<'PY' "${ENV_PATH}" "${PYTHON_BIN}" "${MLX_MODEL_DEFAULT}" "${MLX_ENDPOINT_DEFAULT}"
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
python_bin = sys.argv[2]
mlx_model = sys.argv[3]
mlx_endpoint = sys.argv[4]

updates = {
    "TRICHAT_MLX_PYTHON": python_bin,
    "TRICHAT_MLX_MODEL": mlx_model,
    "TRICHAT_MLX_ENDPOINT": mlx_endpoint,
    "TRICHAT_MLX_SERVER_ENABLED": "0",
    "TRICHAT_LOCAL_INFERENCE_PROVIDER": "auto",
}

existing_lines = env_path.read_text().splitlines() if env_path.exists() else []
seen = set()
output = []
for line in existing_lines:
    if "=" not in line or line.lstrip().startswith("#"):
        output.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in updates:
        output.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f"{key}={value}")
env_path.write_text("\n".join(output).rstrip() + "\n")
PY

echo "[mlx-setup] python=${PYTHON_BIN}"
echo "[mlx-setup] model=${MLX_MODEL_DEFAULT}"
echo "[mlx-setup] endpoint=${MLX_ENDPOINT_DEFAULT}"
