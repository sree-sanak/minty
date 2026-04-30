# Always-on Minty service

Minty can run as an always-on headless daemon that keeps your network data
fresh in the background. No web UI required — the sync daemon, GBrain
export, and MCP server all work standalone.

**Local-first, no telemetry.** The service only makes network calls to
sources you've explicitly configured (Gmail API, WhatsApp Web, etc.).
There are no analytics, crash reporters, or phone-home endpoints.

## Quick start

```bash
npm run service                            # sync daemon on data/
npm run service -- --data-dir ~/minty-data  # custom data directory
npm run service:status                      # check if running
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CRM_DATA_DIR` | `./data` | Data directory |
| `MINTY_USER_UUID` | `single-user` | User UUID for multi-user setups |
| `MINTY_GBRAIN_EXPORT` | unset | Set `1` to enable periodic GBrain export |
| `MINTY_GBRAIN_EXPORT_INTERVAL_MS` | `21600000` (6h) | GBrain export interval |
| `MINTY_DEMO` | unset | Set `1` to use `data-demo/` |

## systemd (Linux)

Create `~/.config/systemd/user/minty.service`:

```ini
[Unit]
Description=Minty relationship sync daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/minty
ExecStart=/usr/bin/node scripts/minty-service.js --data-dir /home/you/minty-data
Restart=on-failure
RestartSec=10

# Optional: GBrain auto-export
Environment=MINTY_GBRAIN_EXPORT=1

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now minty
systemctl --user status minty
journalctl --user -u minty -f
```

The service runs as your user — no root required. Data stays in your home
directory with standard Unix permissions.

## launchd (macOS)

Create `~/Library/LaunchAgents/com.minty.service.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.minty.service</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/minty/scripts/minty-service.js</string>
    <string>--data-dir</string>
    <string>/Users/you/minty-data</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/minty</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/minty.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/minty.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MINTY_GBRAIN_EXPORT</key>
    <string>1</string>
  </dict>
</dict>
</plist>
```

Load and start:

```bash
launchctl load ~/Library/LaunchAgents/com.minty.service.plist
launchctl list | grep minty
tail -f /tmp/minty.log
```

To stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.minty.service.plist
```

Adjust the `node` path to match your system (`which node`). If using nvm,
use the full path to the nvm-managed binary.

## Checking status

```bash
npm run service:status          # human-readable
npm run service:status -- --json  # machine-readable (piped output also uses JSON)
```

The status script reads `service-status.json` and `sync-state.json` from
the data directory and reports PID, uptime, source sync state, and GBrain
export health.

## Graceful shutdown

The service handles `SIGTERM` and `SIGINT` cleanly — it stops all sync
timers and file watchers before exiting. Both systemd and launchd send
`SIGTERM` by default.
