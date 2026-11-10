#!/bin/zsh
# ダブルクリックで Charinco Search を起動し、ブラウザで開く。
# 別の Mac で初めて開くときにつまずきやすいこと（Node.js がない・古い、部品が入っていない、
# 起動を待たずに開いて「接続できません」になる）も、ここで確かめて理由を出す。
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-3000}
URL="http://localhost:$PORT"

# 理由を出して止まる（ウィンドウがすぐ閉じないよう、キーを押すまで待つ）
stop() {
  print "\n⚠️  $1\n"
  read -sk1 "?何かキーを押すと閉じます。"
  print
  exit 1
}

# このフォルダに Node.js を同梱していれば（runtime/node）、それを使う。
# Mac に Node.js を入れられない（管理者の権限がない）ときのため。元の Mac で cp /usr/local/bin/node runtime/node
if [[ -e runtime/node ]]; then
  [[ -x runtime/node ]] || chmod +x runtime/node 2>/dev/null
  if runtime/node -v >/dev/null 2>&1; then
    path=($PWD/runtime $path)
  else
    print "\n⚠️  同梱の Node.js（runtime/node）を、この Mac では動かせませんでした。\n"
  fi
fi
# ダブルクリックで開いたときに Node.js が見つからないことがあるので、よく入る場所も探す
path+=(/usr/local/bin /opt/homebrew/bin $HOME/.volta/bin $HOME/.nvm/versions/node/*/bin(N/nOn[1]))
command -v node >/dev/null || stop "Node.js が入っていません。https://nodejs.org/ja から「LTS」版を入れてから、もう一度このファイルを開いてください（管理者の権限がない Mac では、元の Mac で Node.js をこのフォルダに同梱してください。README の「別の Mac で動かす」）。"
(( $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) >= 20 )) ||
  stop "Node.js が古いです（いま $(node -v)。20 以上が必要です）。https://nodejs.org/ja から「LTS」版を入れてください。"

is_running() { curl -fsS --max-time 2 "$URL/" 2>/dev/null | grep -q 'name="charinco"'; }
# 拡張機能（切り抜き）は Chrome に入れるので、Chrome があれば Chrome で開く
open_app() {
  if [[ -d "/Applications/Google Chrome.app" || -d "$HOME/Applications/Google Chrome.app" ]]; then open -a "Google Chrome" "$URL"; else open "$URL"; fi
}

# すでに動いていれば、開くだけ
if is_running; then
  open_app
  print "Charinco Search はすでに動いています。ブラウザで開きました（このウィンドウは閉じてかまいません）。"
  exit 0
fi
lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 &&
  stop "$PORT 番を別のアプリが使っています。そのアプリを止めてから、もう一度開いてください。"

# 初めて開いたとき（部品が入っていない）は、ここで入れる
if [[ ! -d node_modules/@anthropic-ai/sdk || ! -d node_modules/puppeteer-core ]]; then
  command -v npm >/dev/null || stop "部品（node_modules）が入っていません。元の Mac から、このフォルダを丸ごとコピーし直してください。"
  print "初回の準備をしています（npm install。インターネットが必要です）…"
  npm install --no-audit --no-fund || stop "部品を入れられませんでした。インターネットにつながっているか確かめて、もう一度開いてください。"
fi
[[ -f .env ]] || print "\n⚠️  .env（APIキー）がありません。このままでは検索できません。元の Mac の .env をこのフォルダに入れてください。\n"

node server.mjs &
server=$!
trap 'kill $server 2>/dev/null' EXIT
trap 'exit 0' HUP INT TERM

# 応答するまで待ってから開く（待たずに開くと「接続できません」になる）
for i in {1..120}; do
  is_running && break
  kill -0 $server 2>/dev/null || stop "Charinco Search を起動できませんでした。上に出ているエラーを確かめてください。"
  sleep 0.25
done
is_running || stop "Charinco Search が応答しません。上に出ているエラーを確かめてください。"
open_app
print "\nこのウィンドウを閉じると Charinco Search も止まります。"
wait $server
stop "Charinco Search が止まりました。上に出ているエラーを確かめてください。"
