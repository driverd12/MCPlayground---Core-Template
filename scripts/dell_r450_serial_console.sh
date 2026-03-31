#!/usr/bin/env bash
set -euo pipefail

DEVICE=""
BAUD="115200"
TOOL="${DELL_SERIAL_TOOL:-}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/dell_r450_serial_console.sh --device /dev/cu.usbserial-XXXX [--baud 115200] [--tool tio|picocom|minicom|screen|cu]

Notes:
  - Defaults are tuned for Dell PowerEdge serial console access: 115200 8N1 no flow.
  - `tio` is preferred when available.
EOF
}

pick_tool() {
  if [[ -n "${TOOL}" ]]; then
    printf '%s\n' "${TOOL}"
    return 0
  fi
  for candidate in tio picocom minicom screen cu; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      DEVICE="${2:-}"
      shift 2
      ;;
    --baud)
      BAUD="${2:-}"
      shift 2
      ;;
    --tool)
      TOOL="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${DEVICE}" ]]; then
  echo "error: --device is required" >&2
  ls /dev/cu.* 2>/dev/null | grep -Ev 'Bluetooth-Incoming-Port|debug-console' || true
  exit 2
fi

if [[ ! -e "${DEVICE}" ]]; then
  echo "error: serial device not found: ${DEVICE}" >&2
  exit 2
fi

CONSOLE_TOOL="$(pick_tool || true)"
if [[ -z "${CONSOLE_TOOL}" ]]; then
  echo "error: no supported serial console tool found (tio, picocom, minicom, screen, cu)" >&2
  exit 2
fi

echo "[dell] opening ${DEVICE} with ${CONSOLE_TOOL} at ${BAUD} baud (8N1, flow=none)"

case "${CONSOLE_TOOL}" in
  tio)
    exec tio --baudrate "${BAUD}" --databits 8 --parity none --stopbits 1 --flow none "${DEVICE}"
    ;;
  picocom)
    exec picocom --baud "${BAUD}" --databits 8 --parity n --stopbits 1 --flow n "${DEVICE}"
    ;;
  minicom)
    exec minicom --device "${DEVICE}" --baudrate "${BAUD}" --8bit --color=on --noinit
    ;;
  screen)
    exec screen "${DEVICE}" "${BAUD}"
    ;;
  cu)
    exec cu -l "${DEVICE}" -s "${BAUD}"
    ;;
  *)
    echo "error: unsupported tool: ${CONSOLE_TOOL}" >&2
    exit 2
    ;;
esac
