[Unit]
Description={{serviceName}} - 灵基对话台（OpenAPI 调试前端）
Documentation=file://{{remoteDir}}/current/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={{runUser}}
WorkingDirectory={{remoteDir}}/current
EnvironmentFile={{remoteDir}}/shared/app.env
# HOST 固定 127.0.0.1：只让本机 nginx 访问，密钥页面不暴露到公网
ExecStart={{nodeBin}} server.js
Restart=always
RestartSec=3
LimitNOFILE=65535

# 基础加固：无特权提升、独立临时目录、系统目录只读
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths={{remoteDir}}

[Install]
WantedBy=multi-user.target