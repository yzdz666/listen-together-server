# 一起听服务端部署指南

## 0. 本次已部署的公网实例

| 项目 | 值 |
| --- | --- |
| 网页版 | https://af384ee6deb6e09e2.app.workbuddy.host/?sharecode=MKPWEVLBUS |
| 健康检查 | https://af384ee6deb6e09e2.app.workbuddy.host/health?sharecode=MKPWEVLBUS |
| WebSocket（App 内填写） | `wss://af384ee6deb6e09e2.app.workbuddy.host?sharecode=MKPWEVLBUS` |
| 访问凭据 | `sharecode=MKPWEVLBUS`（HTTP 与 WebSocket 都要带，缺了返回 403） |
| 承载方式 | 平台托管 `node index.js`（监听 `$PORT`） |

> 地址已内置到 App（设置 → 其他 → 一起听 → 服务器地址 / 网页版地址），换域名或自建服务时在 App 里改这两项即可，不用重新打包。
> 分享链接里的 `?sharecode=` 是访问凭据，发给别人时要连它一起发。

## 0.1 网页版与 HTTP 接口

服务端自带一个免构建的网页版，起服务后直接访问 `http://<ip>:23333/` 即可（手机、电脑都行）。
网页端以「成员」身份加入房间：看当前播放、进度、成员、聊天；切歌与进度由手机端的房主控制。刷新页面会用 token 自动回到原房间。
网页端还能**直接播放房主正在放的歌**：房主广播时会附带当前歌曲的音频直链（`music.url`），浏览器用 `<audio>` 自己向音源取流，服务端不中转音频。首次点「同步收听」解锁声音后，切歌、暂停、进度会自动跟随；本地文件或音源限制外链时退化为「仅同步进度」。

| 接口 | 用途 |
| --- | --- |
| `GET /` | 网页版 |
| `GET /health` | 健康检查 |
| `GET /api/info` | 服务信息、房间/人数上限 |
| `GET /api/rooms` | 房间列表（含在线人数、是否有密码） |
| `GET /api/room/:code` | 单个房间快照（成员 + 当前播放状态） |
| `WS  /` | 实时协议：`create` / `join` / `leave` / `state` / `chat` / `transferHost` / `ping` |

静态文件服务支持 `Range` 请求（`206 Partial Content`、`Accept-Ranges: bytes`），所以网页端拖动音频进度、按需缓冲都能正常工作；音频 MIME（mp3/m4a/aac/wav/flac/ogg）也已登记。

所有 HTTP 接口都带 `Access-Control-Allow-Origin: *`，可被任意前端直接 `fetch`；WebSocket 与 HTTP 同端口，前端把 `http(s)://` 换成 `ws(s)://` 即可。

网页版可以被单独托管到任意静态空间，用查询参数指定中继地址：

```text
https://<静态托管域名>/?server=wss://<中继域名>&sharecode=<访问凭据>
```

`?server=` 会自动写到输入框里；`?sharecode=` 只在与页面同域的中继上追加到 WebSocket 连接上。

命令行示例：

```bash
curl http://127.0.0.1:23333/api/rooms
curl http://127.0.0.1:23333/api/room/AB12CD
```

## 1. 最省事：直接跑

```bash
cd listen-together-server
npm install
PORT=23333 ADMIN_PASSWORD='换成你自己的强密码' npm start
```

前台运行，关掉终端就停。适合临时用。

> `ADMIN_PASSWORD` 是下载站管理后台（`/admin.html`：上传安装包、编辑 version.json）的登录密码。
> **不设置时管理接口整体返回 503（`admin_not_configured`）**，一起听与网页版不受影响。
> 服务端不再内置默认密码——公开仓库里人尽皆知的密码，等于没有密码。

## 1.1 管理后台

```bash
PORT=23333 ADMIN_PASSWORD='你的密码' node index.js
# 浏览器打开 http://<ip>:23333/admin.html
```

| 接口 | 用途 |
| --- | --- |
| `POST /api/admin/login` | 密码换取 Token（24 小时有效，HMAC 无状态签名） |
| `POST /api/admin/upload` | 上传 apk / zip / json（单文件上限 300MB） |
| `GET /api/admin/files` | 已发布文件列表 |
| `DELETE /api/admin/file` | 删除文件 |
| `POST /api/admin/version` | 写入 version.json（发布时间自动生成） |

改密码后旧 Token 立即失效（密钥由密码派生）。

## 2. 常驻运行（systemd）

```ini
# /etc/systemd/system/lx-listen-together.service
[Unit]
Description=LX Music Listen Together Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/lx-listen-together
ExecStart=/usr/bin/node index.js
Environment=PORT=23333
Environment=HOST=0.0.0.0
Restart=always
RestartSec=3
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lx-listen-together
sudo systemctl status lx-listen-together
```

## 3. 容器

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js ./
ENV PORT=23333 HOST=0.0.0.0
EXPOSE 23333
CMD ["node", "index.js"]
```

```bash
docker build -t lx-listen-together .
docker run -d --name lx-lt --restart=always -p 23333:23333 lx-listen-together
```

## 4. 公网 + HTTPS（推荐）

服务端本身不处理 TLS，交给反向代理。**App 里填 `wss://你的域名`。**

```nginx
# /etc/nginx/conf.d/lx-lt.conf
server {
    listen 443 ssl http2;
    server_name lt.example.com;

    ssl_certificate     /etc/letsencrypt/live/lt.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lt.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:23333;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # WebSocket 需要长连接，不要设太短的读超时
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /health {
        proxy_pass http://127.0.0.1:23333/health;
        access_log off;
    }
}
```

证书用 certbot 一键申请：

```bash
sudo certbot --nginx -d lt.example.com
```

> Caddy 用户更简单，`reverse_proxy 127.0.0.1:23333` 会自动处理 WebSocket 与证书。

## 5. 临时公网地址（无公网 IP 时）

如果你只有内网机器，可以用 SSH 反向隧道临时映射一个公网域名（**地址在隧道断开后失效**）：

```bash
ssh -o ServerAliveInterval=30 -R 80:localhost:23333 nokey@localhost.run
```

终端会打印形如 `https://xxxxxxxx.lhr.life` 的地址，App 里填 `wss://xxxxxxxx.lhr.life` 即可。

也可以用 cloudflared：

```bash
cloudflared tunnel --url http://localhost:23333
# 得到 https://xxx.trycloudflare.com → App 填 wss://xxx.trycloudflare.com
```

## 6. 验证部署

```bash
curl https://lt.example.com/health
# {"ok":true,"uptime":12,"rooms":0,"members":0}
```

再在本机跑一遍集成测试（需要 `ws` 依赖）：

```bash
cd listen-together-server && npm test
```

网页版的端到端测试（需要本机 Chrome）：

```bash
npm run test:web
```

## 7. 注意事项

- 单房间最多 16 人，进程内存占用随房间数线性增长，小型自用足够。
- 服务端无鉴权、无持久化，房间内消息不落库；不要对外暴露给不可信人群。
- 若放在公网，建议限制来源 IP，或在反向代理层加一层访问限制。
- targetSdk 低于 33 的 Android 客户端不受通知权限限制；iOS 端请使用 `wss://`。
