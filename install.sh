#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 gen_icon.py
npm run compile
VERSION=$(node -p "require('./package.json').version")
PUBLISHER=$(node -p "require('./package.json').publisher")
vsce package --no-dependencies
code --uninstall-extension "${PUBLISHER}.copy-with-ref" 2>/dev/null || true
code --install-extension "copy-with-ref-${VERSION}.vsix"

if command -v cursor &>/dev/null; then
  cursor --uninstall-extension "${PUBLISHER}.copy-with-ref" 2>/dev/null || true
  if cursor --install-extension "copy-with-ref-${VERSION}.vsix" 2>/dev/null; then
    echo "Done. Reload VS Code and Cursor windows to take effect."
  else
    echo "Warning: Cursor installation failed (CLI crash), skip."
    echo "Done. Reload VS Code window to take effect."
  fi
else
  echo "Done. Reload VS Code window to take effect."
fi
