# 一起听中继服务端

LX Music 的「一起听」需要一个 WebSocket 中继服务端：房主的播放状态经由它转发给房间内的其他成员。服务端不存储、不转发任何音频数据，只负责房间管理、成员管理和消息广播（网页版播放时，房主会附带一个音频直链，由浏览器自己向音源取流，流量不经过服务端）。

## 环境要求

- Node.js >= 18
- 能与手机互相访问的网络（同一局域网，或部署在公网）

## 安装与启动

```bash
cd listen-together-server
npm install
npm start
```

默认监听 `0.0.0.0:23333`，启动后会打印可用的局域网地址：

```
Listen Together server listening on 0.0.0.0:23333
  LAN: ws://192.168.1.10:23333
```

在 App 的「设置 → 其他 → 一起听」或「一起听」页面填写这个地址即可。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `23333` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MAX_MEMBERS` | `16` | 单个房间的最大成员数 |

## 部署建议

- **局域网**：手机和运行服务端的电脑连接同一个 Wi-Fi，填写电脑的局域网 IP。注意放行防火墙端口。
- **公网**：建议用 Nginx/Caddy 反向代理并启用 `wss://`，App 中填写 `wss://your-domain`。
  - 服务端本身不提供 TLS，请让反向代理处理证书。
  - 公网部署时请自行增加鉴权、限流等防护，本服务只适合小范围自用。
- **常驻运行**：可使用 `pm2`、`systemd` 或 Docker 自行托管。

## 健康检查

```bash
curl http://127.0.0.1:23333/health
# {"ok":true,"uptime":123,"rooms":1,"members":2}
```

## 测试

```bash
npm test
```

测试脚本会在随机端口自行拉起服务端，覆盖创建/加入/非房主广播被拒/状态转发/聊天/转交房主/密码房/退出/token 重连/未知房间/心跳等用例，结束后自动关闭进程。

## 协议说明

所有消息均为 JSON 文本，客户端 → 服务端：

| type | 说明 |
| --- | --- |
| `create` | 创建房间，参数：`clientId`、`nickname`、`roomName?`、`password?` |
| `join` | 加入房间，参数：`code`、`clientId`、`nickname`、`password?`、`token?` |
| `leave` | 主动退出房间 |
| `state` | 播放状态广播（`music`、`isPlaying`、`position`、`playRate`、`quality`）。房主随时可发；**房间空闲时成员也可发送并成为播放源**（`stateSourceId`），其它端跟随。`music.url` 为可选的音频直链，网页版用它直接播放；只接受 `http(s)`，最长 4096 字符，本地文件恒为 `null`。`quality` 为房间统一音质，非法值会被丢弃。播放源退出时房间状态自动清空 |
| `lyric` | 房主或当前播放源成员推送歌词（`musicId`、`source`、`name`、`singer`、`lrc`、`tlrc?`、`rlrc?`），服务端保存一份供后加入成员补发；`lrc` 最长 64KB，翻译/罗马音各 32KB |
| `control` | 成员发起播放控制（`action: play/pause/seek`，seek 带 `position`），服务端原样转给房主执行 |
| `chat` | 发送聊天消息（最长 500 字符） |
| `transferHost` | 房主把主持权转交给 `targetId` |
| `ping` | 心跳，服务端回 `pong` |

服务端 → 客户端：

| type | 说明 |
| --- | --- |
| `room` | 房间快照，参数：`room`、`selfId`、`token`（重连凭证） |
| `members` | 成员列表与当前房主，成员变动时广播 |
| `state` | 房主播放状态，附带 `from`（房主 id） |
| `chat` | 聊天消息，包含 `type: 'system'` 的系统消息 |
| `lyric` | 房主推送的歌词，附带 `from` |
| `control` | 成员的播放控制请求，附带 `from` 与 `name` |
| `error` | 错误，`code` 取值：`bad_request`、`room_not_found`、`wrong_password`、`room_full`、`already_in_room`、`not_host`、`rate_limited` |
| `kicked` | 被移出房间 |

### 网页版

`GET /` 返回一个免构建的单页客户端（`web/index.html`），手机或电脑浏览器打开即可加入房间，能同步歌名、进度、成员、聊天、**歌词当前句**，并在房主推送了 `music.url` 时直接播放同一首歌。`GET /download.html` 是二改版下载页（APK / 源码），文件在 `web/downloads/` 下。

- 浏览器要求一次用户手势才允许出声，所以首次要点「同步收听」；之后切歌、暂停会自动跟随。
- 如果音源限制外链、链接过期，或房主播的是本地文件，网页端会退化为「仅同步进度」，并提示用 App 收听。
- 页面支持 `?server=wss://...` 指定其它中继、`?sharecode=...` 携带访问凭据。

### 房间生命周期

- 房间码为 6 位大写字母与数字（去掉了易混淆字符），不区分大小写。
- 成员掉线后保留身份 90 秒，客户端在这段时间内带 `token` 重连可恢复原成员身份。
- 房主掉线后先保留房主身份 20 秒，超时后自动把房主转交给最早加入的在线成员。
- 房间内没有任何在线成员后保留 2 分钟，超时自动销毁。
- 每个连接限制 10 秒内最多 120 条消息，单条消息最大 256 KB。
