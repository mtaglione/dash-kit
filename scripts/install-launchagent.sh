#!/bin/zsh
# Keeps the dash kit running on 127.0.0.1:4520 and serves it to the tailnet
# over HTTPS (browsers only allow the microphone on HTTPS or localhost).
#   scripts/install-launchagent.sh          install or restart
#   scripts/install-launchagent.sh remove   stop and remove both
set -e
LABEL=com.miketaglione.dash-kit
PLIST=~/Library/LaunchAgents/$LABEL.plist
REPO=${0:A:h:h}
NODE=${NODE_BIN:-$(command -v node)}
TS_PORT=${TS_PORT:-8452}
if [[ "$1" == remove ]]; then
  launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
  rm -f $PLIST
  tailscale serve --https=$TS_PORT off 2>/dev/null || true
  echo "Removed $LABEL and the tailnet route on :$TS_PORT."; exit 0
fi
mkdir -p ~/Library/Logs/dash-kit
cat > $PLIST <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>4520</string><key>HOST</key><string>127.0.0.1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/dash-kit/stdout.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/dash-kit/stderr.log</string>
</dict></plist>
PLISTEOF
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
# bootout returns before the old service is gone; bootstrap fails (error 5) until it is.
for i in {1..20}; do launchctl print gui/$(id -u)/$LABEL >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap gui/$(id -u) $PLIST
tailscale serve --bg --https=$TS_PORT http://127.0.0.1:4520 >/dev/null
HOSTNAME=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
echo "Running. Local: http://127.0.0.1:4520/  Tailnet: https://$HOSTNAME:$TS_PORT/"
