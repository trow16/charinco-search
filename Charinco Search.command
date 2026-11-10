#!/bin/zsh
# ダブルクリックで Charinco Search を起動し、ブラウザで開く
cd "$(dirname "$0")"
if ! lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
  npm run dev &
  sleep 2
fi
open http://localhost:3000
echo "このウィンドウを閉じると Charinco Search も止まります。"
wait
