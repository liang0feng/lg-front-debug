# ==========================================================================
# 灵基对话台（lg-front-debug）· 独立 location 文件
# 由 deploy/deploy.js nginx 生成并安装，部署时会被覆盖。
# 如需调整，请修改 deploy/templates/lingee-debug.locations.conf.tpl。
#
# 挂载方式：在目标站点的 server { ... } 内加一行
#     include {{locationFile}};
# 访问地址：https://<你的域名>/{{prefix}}/
# ==========================================================================

# 不带结尾斜杠时补斜杠：页面里的相对路径与接口前缀都依赖这个尾斜杠
location = /{{prefix}} {
    return 301 /{{prefix}}/;
}

# 前端静态文件：nginx 直接读取发布目录，不经过 Node 进程
# ^~ 表示命中后不再尝试同级的正则 location（避免站点的 .js/.css 规则抢走请求）
location ^~ /{{prefix}}/ {
    alias {{remoteDir}}/current/public/;
    index index.html;
    autoindex off;

    # 文件名不带内容哈希，用 ETag 协商缓存，避免更新后浏览器拿旧文件
    etag on;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
}

# 接口转发：/{{prefix}}/api/...  →  Node 服务 127.0.0.1:{{appPort}}/api/...
# SSE 必须关闭缓冲与压缩，并放宽读超时，否则流式输出会整段到达或中断
location ^~ /{{prefix}}/api/ {
    proxy_pass http://127.0.0.1:{{appPort}}/api/;
    proxy_http_version 1.1;

    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 转发层（Node）内部会去掉压缩，这里也显式关闭
    proxy_set_header Accept-Encoding "";

    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    chunked_transfer_encoding on;

    client_max_body_size 20m;
}