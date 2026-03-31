#!/usr/bin/env bash
set -euo pipefail

find_cmd() {
  command -v "$1" 2>/dev/null || true
}

pick_console_tool() {
  for candidate in tio picocom minicom screen cu; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

collect_serial_devices() {
  ls /dev/cu.* 2>/dev/null | grep -Ev 'Bluetooth-Incoming-Port|debug-console' || true
}

printf '[dell] ssh: %s\n' "$(ssh -V 2>&1 | head -n 1)"
printf '[dell] tio: %s\n' "$(find_cmd tio || echo missing)"
printf '[dell] picocom: %s\n' "$(find_cmd picocom || echo missing)"
printf '[dell] minicom: %s\n' "$(find_cmd minicom || echo missing)"
printf '[dell] screen: %s\n' "$(find_cmd screen || echo missing)"
printf '[dell] cu: %s\n' "$(find_cmd cu || echo missing)"

PREFERRED_TOOL="$(pick_console_tool || true)"
printf '[dell] preferred console tool: %s\n' "${PREFERRED_TOOL:-none}"

DEVICES="$(collect_serial_devices)"
if [[ -n "${DEVICES}" ]]; then
  printf '[dell] detected serial devices:\n%s\n' "${DEVICES}"
else
  printf '[dell] detected serial devices: none\n'
fi

if [[ -f "${HOME}/.ssh/id_ed25519.pub" ]]; then
  printf '[dell] ssh key: %s\n' "${HOME}/.ssh/id_ed25519.pub"
else
  printf '[dell] ssh key: missing (~/.ssh/id_ed25519.pub)\n'
  printf '[dell] generate with: ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "dan.driver@r450"\n'
fi

cat <<'EOF'
[dell] recommended direct serial settings:
  baud=115200
  databits=8
  parity=none
  stopbits=1
  flow=none

[dell] recommended first-time workflow:
  1. Attach the USB-to-serial or null-modem adapter.
  2. Re-run: npm run dell:r450:doctor
  3. Open serial: npm run dell:r450:serial -- --device /dev/cu.usbserial-XXXX
  4. Configure BIOS/iDRAC serial redirection to COM1 or COM2 as needed.
  5. Once network is up, print SSH guidance: npm run dell:r450:ssh -- --host <idrac-or-host-ip>

[dell] iDRAC / SOL notes:
  - BIOS serial redirection commonly uses COM1.
  - iDRAC Serial Over LAN commonly lands on COM2 inside racadm SSH sessions.
  - Dell docs commonly show: console com2
EOF
