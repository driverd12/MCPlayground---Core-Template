#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-$(pwd)}"
ENV_PATH="${DOTENV_CONFIG_PATH:-${REPO_ROOT}/.env}"

if [[ ! -f "${ENV_PATH}" ]]; then
  exit 0
fi

node --input-type=module - "${ENV_PATH}" <<'NODE'
import fs from "node:fs";
import dotenv from "dotenv";

const envPath = process.argv[2];
const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));

for (const [key, rawValue] of Object.entries(parsed)) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    continue;
  }
  const value = String(rawValue).replace(/'/g, "'\\''");
  process.stdout.write(`export ${key}='${value}'\n`);
}
NODE
