#!/bin/bash
# 求职自动投递助手：更新到 GitHub 上的最新版。
# 用法：双击这个文件（第一次如果 macOS 不让打开，就在终端里输入 bash 再把它拖进来，回车）。
# 你的资料、简历、投递记录都存在 Chrome 里，不在这个文件夹里，更新不会丢。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="MuellerYu/job-apply-helper"
cd "$DIR"
echo "正在更新：$DIR"

if [ -d .git ] && command -v git >/dev/null 2>&1; then
  git pull --ff-only
else
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.zip" -o "$TMP/latest.zip"
  ditto -x -k "$TMP/latest.zip" "$TMP/x"
  SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -1)"
  rsync -a --exclude '.git' "$SRC/" "$DIR/"
  rm -rf "$TMP"
fi

# 本地连接（Codex）也更新一下
if [ -f "$DIR/native-host/install.sh" ]; then
  bash "$DIR/native-host/install.sh" >/dev/null && echo "本地连接已更新"
fi

V="$(sed -n 's/.*"build": *"\([^"]*\)".*/\1/p' "$DIR/version.json" 2>/dev/null)"
echo ""
echo "✅ 已更新到 ${V:-最新版}。回到 Chrome 刷新任意网页，插件会自动换成新版本。"
echo "   （如果没换：打开 chrome://extensions，点这个插件上的刷新按钮。）"
