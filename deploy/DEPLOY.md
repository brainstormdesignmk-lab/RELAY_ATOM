# Deploy to Atom4 (32-bit, Node 16)

Target: `/opt/metropolis/relay` + systemd (`deploy/relay.service`).

1. Copy the project to the Atom:
   ```bash
   rsync -a --exclude .env --exclude .git --exclude data/ \
     ./ atom4:/opt/metropolis/relay/
   ```
2. Create `/opt/metropolis/relay/.env` **on the Atom** (do NOT reuse the dev one):
   - `NODE_ID=atom4`, `RELAY_ROLE=relay`
   - `ATOM1_HOST/ATOM2_HOST/ATOM3_HOST` = real IPs reachable from Atom4
   - `RELAY_TOKEN*` = same values the atoms/adapters use
   - Optional on small boards: `MAX_BODY_BYTES=262144`
3. Sanity checks on the Atom:
   ```bash
   node -v                      # must be >=16 (v16.x expected)
   ss -tlnp | grep 8400         # must be empty
   node test/run.js | tail -1   # expect: NN tests: NN pass, 0 fail
   ```
4. Install the service:
   ```bash
   sudo cp deploy/relay.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now relay
   curl -s http://127.0.0.1:8400/health   # expect {"status":"ok",...}
   ```
5. Logs / restarts: `journalctl -u relay -f`. The unit restarts the relay
   automatically after crashes (`Restart=always`).

Notes:
- Clock matters: queue ordering sorts by timestamped filenames. Ensure NTP
  (`timedatectl status` shows "synchronized: yes") — the board has no RTC.
- Keep port 8400 LAN-only. Public webhook ingress (Viber/WhatsApp) goes
  through a TLS tunnel/proxy, never exposed directly.
- Until Atoms 1-3 are reachable, inbound traffic accumulates in
  `data/retry/` and `data/holding/` — the relay is stable but idle.
- SD-card wear: dedup log compacts every 5000 appends; retention defaults
  (processed 24h, failed 30d) are safe for secretary-scale volume.
