#!/usr/bin/env bash
# 启动下载站 / 一起听服务端（默认 3000 端口，平台网关按这个端口转发）
# 管理密码来源：ADMIN_PASSWORD 环境变量 > 同目录 .admin-secret 文件（不进仓库）
cd "$(dirname "$0")" || exit 1
exec env PORT="${PORT:-3000}" node index.js
