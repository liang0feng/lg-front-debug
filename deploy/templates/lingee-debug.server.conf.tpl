# ==========================================================================
# 灵基对话台（lg-front-debug）· 独立域名方案（完整 server 块）
# 适用于给本应用单独分配一个域名/子域名，放到 nginx 站点目录（如 conf.d）。
# 若要 HTTPS，把 listen 80 改为 443 并补 ssl_certificate 配置，
# 或让外层统一做 80 → 443 跳转。
# ==========================================================================

server {
    listen 80;
    server_name {{serverName}};

    client_max_body_size 20m;

    # 前端静态文件：nginx 直接读取发布目录
    location ^~ / {
        alias {{remoteDir}}/current/public/;
        index index.html;
        autoindex off;

        etag on;
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
    }

    # 接口转发到 Node 服务；SSE 需要关闭缓冲与压缩
    location /api/ {
        proxy_pass http://127.0.0.1:{{appPort}}/api/;
        proxy_http_version 1.1;

        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
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

    access_log /var/log/nginx/{{serviceName}}.access.log;
    error_log  /var/log/nginx/{{serviceName}}.error.log warn;
}