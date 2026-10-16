# Atom4 relay deployment (antiX 21, 32-bit Node 16)

## Live layout

- Project: `/home/atom/Documents/PROJECTS/RELAY`
- Environment: `/home/atom/.relay/relay.env` (mode `600`; never copy it from a workstation)
- Data/spool: the configured `DATA_DIR` under the project data directory
- Runtime: `node src/relay.js`, Node 16.20.x
- Current boot launch: Atom4's user crontab `@reboot` entry, which sources the environment and launches Node with `nohup`

The checked-in `deploy/relay.service` is a systemd template for systemd hosts. Atom4 runs antiX and does not use systemd; do not install that unit there. The current `@reboot` launch does not by itself restart a process that crashes after boot. Check the Atom4 monitor/watchdog before treating the relay as appliance-grade.

## Configuration

Start from `deploy/relay.env.example`; create the live file at `~/.relay/relay.env` and set mode `600`. At minimum, configure the LAN bind/port, Atom1 address, bot-to-atom mapping, and separate relay credentials for the secretary and phone bridge. Relay credentials are not Viber credentials.

The current live identities are `LINA1` pinned to `atom1`, and `viber1` for the phone bridge. The bridge submits inbound messages to `/inbound`; Lina submits replies to `/outbound`; the bridge claims, acknowledges, or rejects its own queue. Keep port 8400 LAN-only or behind the intended authenticated TLS proxy.

## Release procedure

1. Preserve the current `data/` spool and `~/.relay/relay.env`.
2. Compare the candidate release with the deployed source and record its commit/hash.
3. Deploy source files only; do not replace `data/` or the environment file.
4. Restart using the documented Atom4 mechanism and confirm there is exactly one relay process.
5. Verify `GET http://127.0.0.1:8400/health` locally on Atom4 and check the queue counts.
6. Confirm inbound and outbound paths with controlled, non-customer messages before returning to normal traffic.

For Node 16-compatible tests, run `npm test` from the project root before a release. Do not deploy a candidate that has not been reviewed against the live queue format.
