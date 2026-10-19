#!/bin/bash
# 求职自动投递助手：安装「本地连接」，让插件能调用你电脑上的 Codex（ChatGPT 桌面版自带）。
# 用法：在「终端」里运行 bash 把这个文件拖进来，回车。改了 codex_host.py 之后再运行一次。
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$HOME/.wdaf"
HOST_NAME="com.jobhelper.codex"
EXT_ID="plhadcgaphjfmcbjgnaehhoemoihnfml"
CV="$HOME/Desktop/求职材料"

mkdir -p "$HOST_DIR/cover-work/Cover Letters" "$HOST_DIR/cover-work/Writing Samples"
cp "$SRC/codex_host.py" "$HOST_DIR/codex_host.py"
# 自己准备的 writing sample 素材和提示词（可选，见说明）
[ -f "$SRC/writing-sample-source.md" ] && cp "$SRC/writing-sample-source.md" "$HOST_DIR/"
[ -f "$SRC/writing-sample-prompt.md" ] && cp "$SRC/writing-sample-prompt.md" "$HOST_DIR/"

# 找 Codex
CODEX=""
for c in "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" \
         "/Applications/Codex.app/Contents/Resources/codex" \
         "$(command -v codex 2>/dev/null)" "/opt/homebrew/bin/codex" "/usr/local/bin/codex" "$HOME/.local/bin/codex"; do
  if [ -n "$c" ] && [ -x "$c" ]; then CODEX="$c"; break; fi
done
if [ -z "$CODEX" ]; then
  echo "⚠️  没找到 Codex。请先安装 ChatGPT 桌面版（https://chatgpt.com/download）并登录，打开一次里面的 Codex；"
  echo "   或者用 Homebrew 装：brew install codex，再运行 codex login。装好后重新运行本脚本。"
  echo "   （不装也能用：插件照样按规则自动填表，只是不能让 AI 答新题、写 cover letter。）"
else
  echo "Codex：$CODEX"
  "$CODEX" --version 2>/dev/null || true
fi

cat > "$HOST_DIR/host_config.json" <<JSON
{
  "codex": "$CODEX",
  "cvDir": "$CV"
}
JSON

# 启动程序：带上现在终端里的 PATH（Codex 运行时可能要用到）
cat > "$HOST_DIR/codex_host" <<WRAP
#!/bin/bash
exec 2>>"\$HOME/.wdaf/wrapper.log"
export PATH="$PATH"
exec /usr/bin/python3 "$HOST_DIR/codex_host.py" "\$@"
WRAP
chmod 755 "$HOST_DIR/codex_host"

# 登记给 Chrome（Chrome、Chrome Beta、Edge、Brave 有就都登记）
for d in "Google/Chrome" "Google/Chrome Beta" "Microsoft Edge" "BraveSoftware/Brave-Browser"; do
  base="$HOME/Library/Application Support/$d"
  [ -d "$base" ] || continue
  mkdir -p "$base/NativeMessagingHosts"
  cat > "$base/NativeMessagingHosts/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "求职自动投递助手：调用本机 Codex",
  "path": "$HOST_DIR/codex_host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
done

mkdir -p "$CV/Cover Letters" 2>/dev/null || true
echo "✅ 已安装本地连接：$HOST_DIR"
echo "   cover letter 会放在：$CV/Cover Letters（第一次写时 macOS 可能问「Chrome 想要控制访达」，点「好」）"
echo "   回到插件设置页点「测试连接」确认。"
