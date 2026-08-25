#!/bin/bash
# Boot one of two apps in a shared image, chosen by the APP env var:
#   APP=dsh     (default) — DeepSeek Harness web (+ harness-lark plugin if present)
#   APP=pi-web            — pi coding agent web UI
#
# The dsh profile lives in the DSH_HOME volume (/root/.dsh), which starts empty
# on a fresh volume, so the harness-lark plugin is installed at first start (not
# baked in). A marker file skips re-installation on later restarts. The plugin
# declares `dsh.bundle.patch`, so `dsh plugin add` applies its cordis.patch.yml
# automatically as a bundle layer.
set -e

APP=${APP:-dsh}

start_pi_web() {
  # pi-web is a Next.js server. It binds 127.0.0.1 (container loopback) by
  # default, which Docker's published port can't reach; bind 0.0.0.0 so the
  # published port works. Sessions are read from PI_CODING_AGENT_DIR
  # (default ~/.pi/agent/sessions).
  local port="${PI_WEB_PORT:-30141}"
  local host="${PI_WEB_HOST:-0.0.0.0}"
  echo "[entrypoint] starting pi-web on ${host}:${port}..."
  exec pi-web --port "$port" --hostname "$host"
}

start_dsh() {
  export DSH_HOME=${DSH_HOME:-/root/.dsh}
  local PROFILE_DIR="$DSH_HOME/profiles/web"
  local PLUGIN_SRC=/plugins/harness-lark

  # dsh web binds the container loopback by design (safety). Docker's published
  # port reaches the container's bridge IP, not its loopback, so expose the UI
  # through a tiny TCP forwarder on the container's own IP. Disable with
  # DSH_WEB_FORWARD=0.
  if [ "${DSH_WEB_FORWARD:-1}" != "0" ] && [ -f /usr/local/bin/dsh-port-forward.js ]; then
    node /usr/local/bin/dsh-port-forward.js 3080 &
  fi

  install_plugin() {
    dsh plugin --profile web add "file:$PLUGIN_SRC" > /tmp/plugin-install.log 2>&1
  }

  if [ ! -d "$PLUGIN_SRC" ]; then
    # The plain target ships this same entrypoint but no plugin source dir; only
    # the lark/combined targets COPY /plugins/harness-lark. Skip the install
    # cleanly so the stock `dsh web` image boots without a spurious failure.
    echo "[entrypoint] no plugin source at $PLUGIN_SRC, skipping plugin install"
  elif [ ! -f "$PROFILE_DIR/.harness-lark-installed" ]; then
    echo '[entrypoint] installing harness-lark plugin...'
    if ! install_plugin; then
      # The npm dsh profile template leaves `allowBuilds.protobufjs` as the
      # placeholder text "set this to true or false"; pnpm then blocks that
      # build script and plugin add fails. Protobufjs's postinstall is a
      # harmless regeneration (production profiles set it to true), so patch
      # the value and retry once before giving up loud.
      echo '[entrypoint] plugin add failed, patching allowBuilds.protobufjs and retrying...'
      sed -i 's/^\([[:space:]]*protobufjs:\).*$/\1 true/' "$PROFILE_DIR/pnpm-workspace.yaml" || true
      if ! install_plugin; then
        echo '[entrypoint] FATAL: harness-lark plugin install failed:'
        tail -10 /tmp/plugin-install.log
        exit 1
      fi
    fi
    touch "$PROFILE_DIR/.harness-lark-installed"
    echo '[entrypoint] harness-lark installed (plugin cordis.patch.yml applied as bundle layer)'
  fi

  echo '[entrypoint] starting dsh web...'
  # dsh's /api trust fence rejects browsers whose Host is not explicitly trusted
  # (it refuses binding 0.0.0.0, so LAN addresses are never auto-trusted). Pass
  # every authority from DSH_TRUSTED_HOSTS (space-separated host or host:port).
  local TRUSTED_ARGS=()
  for authority in ${DSH_TRUSTED_HOSTS:-}; do
    TRUSTED_ARGS+=(--trusted-host "$authority")
  done
  exec dsh --profile web "${TRUSTED_ARGS[@]}"
}

case "$APP" in
  pi-web) start_pi_web ;;
  dsh)    start_dsh ;;
  *)      echo "[entrypoint] FATAL: unknown APP='$APP' (expected 'dsh' or 'pi-web')"; exit 1 ;;
esac
