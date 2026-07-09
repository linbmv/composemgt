#!/usr/bin/env bash
# ===================================================================================
#   ComposeMgt 一键部署脚本
#   约定：选一个「容器数据根目录」($STACK_DIR)，把 compose.yml、.env、composemgt/
#   以及今后每个容器的数据目录全部放在这一层；每个容器的数据 / 映射目录 / .env
#   都收纳在它自己的 <容器名>/ 子目录下。
# ===================================================================================
set -euo pipefail

# --- 定位脚本所在目录（即 composemgt 项目根）---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================================================"
echo "  ComposeMgt 部署向导"
echo "======================================================================"

# --- 1. 询问容器数据根目录（默认：composemgt 的上一级）---
DEFAULT_STACK_DIR="$(dirname "$SCRIPT_DIR")"
read -rp "容器数据根目录 [$DEFAULT_STACK_DIR]: " STACK_DIR
STACK_DIR="${STACK_DIR:-$DEFAULT_STACK_DIR}"
mkdir -p "$STACK_DIR"
STACK_DIR="$(cd "$STACK_DIR" && pwd)"   # 规范化为绝对路径

# composemgt 必须位于 STACK_DIR 之下（约定），据此计算构建上下文相对路径
case "$SCRIPT_DIR/" in
  "$STACK_DIR/"*) : ;;
  *)
    echo "❌ 错误：composemgt 目录 ($SCRIPT_DIR) 不在所选根目录 ($STACK_DIR) 之下。"
    echo "   请把 composemgt 放到根目录里，例如： $STACK_DIR/composemgt"
    exit 1
    ;;
esac
REL_UNDER_STACK="${SCRIPT_DIR#"$STACK_DIR"/}"      # 例：composemgt
REL_CONTEXT="./${REL_UNDER_STACK}/manager"        # 例：./composemgt/manager

# --- 2. 询问网络参数 ---
read -rp "主机/Tailscale IP (TS_HOST_IP) [100.101.102.100]: " TS_HOST_IP
TS_HOST_IP="${TS_HOST_IP:-100.101.102.100}"
read -rp "子网前缀 (SUBNET_PREFIX) [172.18.0]: " SUBNET_PREFIX
SUBNET_PREFIX="${SUBNET_PREFIX:-172.18.0}"

echo ""
echo "→ 根目录:       $STACK_DIR"
echo "→ 构建上下文:   $REL_CONTEXT"
echo "→ TS_HOST_IP:   $TS_HOST_IP"
echo "→ SUBNET_PREFIX:$SUBNET_PREFIX"
echo ""

# --- 3. 生成全局 .env（若不存在）---
ENV_FILE="$STACK_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# ====================== 全局配置 ======================
TS_HOST_IP=$TS_HOST_IP
SUBNET_PREFIX=$SUBNET_PREFIX
TZ=Asia/Shanghai
EOF
  chmod 644 "$ENV_FILE"
  echo "✅ 已生成 $ENV_FILE"
else
  echo "ℹ️  $ENV_FILE 已存在，跳过（不覆盖）"
fi

# --- 4. 确保 D_Home 网络存在 ---
if command -v docker >/dev/null 2>&1; then
  if ! docker network inspect D_Home >/dev/null 2>&1; then
    docker network create --driver bridge --subnet "${SUBNET_PREFIX}.0/24" D_Home
    echo "✅ 已创建 D_Home 网络 (${SUBNET_PREFIX}.0/24)"
  else
    echo "ℹ️  D_Home 网络已存在"
  fi
else
  echo "⚠️  未检测到 docker 命令，跳过网络创建"
fi

# --- 5. 生成 include 布局：主 compose.yml + composemgt/compose.yml ---
COMPOSE_FILE="$STACK_DIR/compose.yml"
# composemgt 自身作为 include 的第一项，其定义放在克隆目录里的 compose.yml
BASE_DIR_NAME="$REL_UNDER_STACK"          # 例：composemgt
BASE_SERVICE_FILE="$SCRIPT_DIR/compose.yml"
BASE_INCLUDE_ENTRY="$BASE_DIR_NAME/compose.yml"

# 生成 composemgt 自包含 compose 文件（占用 .254 / 65535，身份挂载 $STACK_DIR）
# 构建上下文为 ./manager（相对该文件自己的目录）。
gen_base_service_file() {
  cat <<'YAML'
# composemgt —— 管理面板自身（基础服务），由 ComposeMgt 管理
# 可单独运行： cd composemgt && docker compose up -d
services:
  composemgt:
    container_name: composemgt-dashboard
    build:
      context: ./manager
      dockerfile: Dockerfile
    networks:
      D_Home:
        ipv4_address: ${SUBNET_PREFIX}.254
    ports:
      - target: 9988
        published: 65535
        host_ip: ${TS_HOST_IP}
        protocol: tcp
    environment:
      COMPOSE_FILE_PATH: __STACK__/compose.yml
      ENV_FILE_PATH: __STACK__/.env
      WORK_DIR: __STACK__
      PORT: "9988"
      NODE_ENV: production
      TZ: Asia/Shanghai
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - __STACK__:__STACK__
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
networks:
  D_Home:
    external: true
YAML
}

# composemgt/compose.yml（若不存在则生成）
if [ ! -f "$BASE_SERVICE_FILE" ]; then
  gen_base_service_file | sed "s#__STACK__#${STACK_DIR}#g" > "$BASE_SERVICE_FILE"
  echo "✅ 已生成 $BASE_SERVICE_FILE"
else
  echo "ℹ️  $BASE_SERVICE_FILE 已存在，跳过"
fi

# composemgt 自己的 .env（补入全局插值变量，便于单独运行）
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  printf 'TS_HOST_IP=%s\nSUBNET_PREFIX=%s\nTZ=Asia/Shanghai\n' "$TS_HOST_IP" "$SUBNET_PREFIX" > "$SCRIPT_DIR/.env"
fi

# 主 compose.yml（networks + include 列表，composemgt 第一项）
if [ ! -f "$COMPOSE_FILE" ]; then
  {
    echo "# ==================================================================================="
    echo "#   主编排文件（include 布局，由 ComposeMgt 管理）"
    echo "#   每个容器的定义在各自的 <name>/compose.yml 中，可单独运行。"
    echo "#   composemgt 为基础服务，固定第一项，请勿删除。"
    echo "# ==================================================================================="
    echo "networks:"
    echo "  D_Home:"
    echo "    external: true"
    echo ""
    echo "include:"
    echo "  - $BASE_INCLUDE_ENTRY"
  } > "$COMPOSE_FILE"
  echo "✅ 已生成 $COMPOSE_FILE（include: $BASE_INCLUDE_ENTRY 第一项）"
else
  if grep -qE "include:" "$COMPOSE_FILE"; then
    if ! grep -qE "$BASE_DIR_NAME/compose\.yml" "$COMPOSE_FILE"; then
      echo "⚠️  $COMPOSE_FILE 已是 include 布局，但未包含 $BASE_INCLUDE_ENTRY。"
      echo "   请把 '- $BASE_INCLUDE_ENTRY' 作为 include 列表【第一项】手动加入。"
      exit 1
    fi
    echo "ℹ️  $COMPOSE_FILE 已是 include 布局且包含 composemgt，跳过生成"
  else
    echo "⚠️  $COMPOSE_FILE 已存在但仍是旧的单一 (services) 布局。"
    echo "   请先运行迁移脚本转换为 include 布局： ./migrate-to-include.sh"
    exit 1
  fi
fi

# --- 6. 构建并启动管理面板 ---
if command -v docker >/dev/null 2>&1; then
  echo ""
  echo "→ 构建并启动 composemgt ..."
  cd "$STACK_DIR"
  docker compose up -d --build composemgt
  echo ""
  echo "✅ 部署完成。访问： http://${TS_HOST_IP}:65535"
  echo "   查看日志： docker compose logs -f composemgt"
else
  echo ""
  echo "⚠️  未检测到 docker，已生成配置文件但未启动。"
  echo "   请在装有 docker 的主机上执行： cd $STACK_DIR && docker compose up -d --build composemgt"
fi
