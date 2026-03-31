# Dell R450 Serial and SSH Readiness

This Mac is now prepared for first-time Dell PowerEdge R450 access over direct serial and SSH.

## Installed local tooling

- `ssh`
- `screen`
- `cu`
- `tio`
- `picocom`
- `minicom`
- `lrzsz`

## Repo helpers

- `npm run dell:r450:doctor`
  - Verifies local tooling
  - Lists candidate `/dev/cu.*` devices
  - Prints recommended console settings
- `npm run dell:r450:serial -- --device /dev/cu.usbserial-XXXX`
  - Opens a direct serial console using the best available local tool
  - Defaults to `115200 8N1 flow=none`
- `npm run dell:r450:ssh -- --host <idrac-or-server-ip>`
  - Prints a suggested `~/.ssh/config` block
  - Verifies whether a local ed25519 key already exists

## Recommended direct serial settings

- Baud: `115200`
- Data bits: `8`
- Parity: `none`
- Stop bits: `1`
- Flow control: `none`

## Physical connection notes

- Older or rear serial paths often use DB9 null-modem cabling.
- On this Mac, a USB-to-RS232 adapter will normally appear as `/dev/cu.usbserial-*` or `/dev/cu.usbmodem-*`.
- Re-run `npm run dell:r450:doctor` after attaching the adapter to confirm the device path.

## Dell / iDRAC notes

- BIOS serial redirection typically uses `COM1`.
- iDRAC Serial Over LAN commonly maps to `COM2`.
- A common iDRAC SSH path is:
  - `ssh root@<idrac-host>`
  - `racadm console com2`

## Planned next step

When the R450 is physically available, the next implementation step should be a real MCP-facing remote-access readiness tool that:

- validates the attached serial adapter
- validates SSH reachability
- records the chosen serial device and SSH profile
- creates a bounded remote-management runbook artifact in the MCP store

That has not been implemented yet. The current repo state is readiness tooling plus repeatable local wrappers.
