#!/usr/bin/env bash
# ===================================================================================
#   migrate-to-include.sh
#   把「单一 compose.yml」迁移为 include 布局（每容器一个自包含 compose.yml）。
#   非破坏：原文件备份为 compose.yml.monolithic.bak，可随时回滚。
# ===================================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 容器数据根目录（默认：composemgt 的上一级）
DEFAULT_STACK_DIR="$(dirname "$SCRIPT_DIR")"
STACK_DIR="${WORK_DIR:-}"
if [ -z "$STACK_DIR" ]; then
  read -rp "容器数据根目录 [$DEFAULT_STACK_DIR]: " STACK_DIR
  STACK_DIR="${STACK_DIR:-$DEFAULT_STACK_DIR}"
fi
STACK_DIR="$(cd "$STACK_DIR" && pwd)"

COMPOSE_FILE="${COMPOSE_FILE_PATH:-$STACK_DIR/compose.yml}"

echo "======================================================================"
echo "  迁移到 include 布局"
echo "  根目录:   $STACK_DIR"
echo "  主文件:   $COMPOSE_FILE"
echo "======================================================================"
echo ""
echo "将执行："
echo "  1. 备份 compose.yml -> compose.yml.monolithic.bak"
echo "  2. 每个服务拆分到 <name>/compose.yml（自包含，可单独运行）"
echo "  3. 生成新的 include 式主 compose.yml"
echo ""
read -rp "确认继续？(y/N): " ans
case "$ans" in
  y|Y) : ;;
  *) echo "已取消。"; exit 0 ;;
esac

# 运行 Node 迁移脚本
WORK_DIR="$STACK_DIR" COMPOSE_FILE_PATH="$COMPOSE_FILE" ENV_FILE_PATH="$STACK_DIR/.env" \
  node "$SCRIPT_DIR/migrate-to-include.js" "$@"

# 校验（若有 docker）
if command -v docker >/dev/null 2>&1; then
  echo ""
  echo "→ 用 docker compose config 校验迁移前后服务集一致..."
  cd "$STACK_DIR"
  BEFORE="$(docker compose -f "$(basename "$COMPOSE_FILE").monolithic.bak" config --services 2>/dev/null | sort || true)"
  AFTER="$(docker compose config --services 2>/dev/null | sort || true)"
  if [ "$BEFORE" = "$AFTER" ] && [ -n "$AFTER" ]; then
    echo "✅ 服务集一致：迁移前后 docker compose 识别到相同的服务。"
  else
    echo "⚠️  服务集有差异，请人工核对："
    echo "--- before ---"; echo "$BEFORE"
    echo "--- after ----"; echo "$AFTER"
    echo "如需回滚： cp $(basename "$COMPOSE_FILE").monolithic.bak $(basename "$COMPOSE_FILE")"
  fi
else
  echo "⚠️  未检测到 docker，跳过 config 校验。"
fi
