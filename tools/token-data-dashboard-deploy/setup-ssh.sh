#!/bin/bash
set -euo pipefail

SERVER="devuser@10.4.181.124"

KEY_FILE=""
for key in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa"; do
  if [ -f "$key" ]; then
    KEY_FILE="$key"
    echo "检测到已有 SSH Key: $KEY_FILE"
    break
  fi
done

if [ -z "$KEY_FILE" ]; then
  KEY_FILE="$HOME/.ssh/id_ed25519"
  echo "未检测到 SSH Key，正在生成..."
  ssh-keygen -t ed25519 -f "$KEY_FILE" -N "" -q
fi

echo "正在将公钥分发到服务器，请输入服务器密码..."
ssh-copy-id -i "$KEY_FILE.pub" "$SERVER"

echo "验证免密登录..."
ssh -o BatchMode=yes "$SERVER" "echo '免密登录配置成功!'" || {
  echo "配置失败，请检查网络或密码是否正确"
  exit 1
}
