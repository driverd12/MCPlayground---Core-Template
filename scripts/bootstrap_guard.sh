#!/usr/bin/env bash

mcplayground_bootstrap_stop() {
  local script_label="${1:-script}"
  local reason="${2:-bootstrap prerequisite is missing}"
  local detail="${3:-}"
  printf '[%s] Stop: %s\n' "${script_label}" "${reason}" >&2
  if [[ -n "${detail}" ]]; then
    printf '[%s] Detail: %s\n' "${script_label}" "${detail}" >&2
  fi
  printf '[%s] Next step: run `npm run bootstrap:env` from the repo root.\n' "${script_label}" >&2
  printf '[%s] If runtime pins are missing, run `npm run bootstrap:env:install` first.\n' "${script_label}" >&2
}

mcplayground_require_node_mcp_client() {
  local repo_root="${1:?repo root required}"
  local script_label="${2:-script}"
  local probe="${MCP_BOOTSTRAP_PREFLIGHT_NODE_MODULES_DIR:-${repo_root}/node_modules/@modelcontextprotocol/sdk}"
  if [[ ! -d "${probe}" ]]; then
    mcplayground_bootstrap_stop \
      "${script_label}" \
      "Node MCP client dependencies are not installed." \
      "Missing ${probe}; scripts/mcp_tool_call.mjs cannot run without npm dependencies."
    exit 1
  fi
}

mcplayground_require_dist_server() {
  local repo_root="${1:?repo root required}"
  local script_label="${2:-script}"
  local probe="${MCP_BOOTSTRAP_PREFLIGHT_DIST_SERVER:-${repo_root}/dist/server.js}"
  if [[ ! -f "${probe}" ]]; then
    mcplayground_bootstrap_stop \
      "${script_label}" \
      "compiled MCP server output is missing." \
      "Missing ${probe}; STDIO transport needs dist/server.js."
    exit 1
  fi
}
