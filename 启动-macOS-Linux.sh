#!/bin/sh
# 灵基对话台 · macOS / Linux 启动脚本
# 用法：双击（部分桌面环境）或在终端执行  ./启动-macOS-Linux.sh
# 若提示没有执行权限，先运行： chmod +x 启动-macOS-Linux.sh

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  未检测到 Node.js。"
  echo "  请先安装 Node 18 或更高版本： https://nodejs.org/"
  echo ""
  exit 1
fi

exec node ./start.js "$@"