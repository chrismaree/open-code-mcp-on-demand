#!/usr/bin/env sh
# Installs the mcp-on-demand OpenCode plugin.
#   curl -fsSL https://raw.githubusercontent.com/chrismaree/open-code-mcp-on-demand/master/install.sh | sh
# Re-run to update the plugin; your settings file is never overwritten.
set -eu

REPO_RAW="${MCP_ON_DEMAND_SOURCE:-https://raw.githubusercontent.com/chrismaree/open-code-mcp-on-demand/master}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"
SETTINGS="$CONFIG_DIR/mcp-on-demand.json"

fetch() {
  case "$REPO_RAW" in
    http*) curl -fsSL "$REPO_RAW/$1" -o "$2" ;;
    *) cp "$REPO_RAW/$1" "$2" ;;
  esac
}

mkdir -p "$PLUGIN_DIR"
fetch mcp-on-demand.ts "$PLUGIN_DIR/mcp-on-demand.ts"
echo "Installed plugin: $PLUGIN_DIR/mcp-on-demand.ts"

if [ -f "$SETTINGS" ]; then
  echo "Kept existing settings: $SETTINGS"
else
  cat > "$SETTINGS" <<'EOF'
{
  "enabled": true,
  "alwaysOn": [],
  "localIdleHours": 6,
  "groups": {},
  "autoConnect": []
}
EOF
  echo "Created starter settings: $SETTINGS"
fi

cat <<'EOF'

Done. Every MCP server is now dormant until an agent calls mcp_connect.

Next steps:
  1. Restart OpenCode (or open a new session).
  2. Group your servers: paste the "Generate your settings" prompt from the README
     into an OpenCode session.
  3. Check it worked: ask the agent to run mcp_status.

Uninstall: rm "$HOME/.config/opencode/plugins/mcp-on-demand.ts"
EOF
