# 灵基对话台运行环境（systemd EnvironmentFile）
# 端口与 Node 服务的监听地址；HOST 保持 127.0.0.1，只由 nginx 对外提供访问。
HOST=127.0.0.1
PORT={{appPort}}
# 默认转发目标；页面「连接设置」里的服务地址会以 X-Target 头覆盖它
TARGET={{target}}
NODE_ENV=production