#!/bin/bash
set -euo pipefail

SERVER="devuser@10.4.181.124"

echo "=== token-data-dashboard 自动部署 ==="

ssh -o BatchMode=yes -o ConnectTimeout=5 "$SERVER" "true" 2>/dev/null || {
  echo "错误: 无法免密连接服务器，请先运行 ./tool/setup-ssh.sh 配置 SSH Key"
  exit 1
}

ssh "$SERVER" bash -s <<'EOF'
  set -euo pipefail
  cd ~/codeup/token-data-dashboard

  echo "[1/2] 拉取最新代码..."
  git pull origin main
  echo ""
  echo "最新提交:"
  git log -1 --format="  commit: %h%n  作者:   %an <%ae>%n  时间:   %ci%n  信息:   %s"
  echo ""

  echo "[2/2] 启动服务..."
  ./start.sh

  echo "部署完成!"
EOF
