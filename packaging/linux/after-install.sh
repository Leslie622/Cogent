#!/bin/bash
set -e

APP_DIR="/opt/${sanitizedProductName:-}"
if [ -n "$APP_DIR" ] && [ -f "$APP_DIR/chrome-sandbox" ]; then
  chmod 4755 "$APP_DIR/chrome-sandbox" || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
