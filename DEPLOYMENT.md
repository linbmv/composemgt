# ComposeMgt 部署指南

## 架构：include 布局（集中管理 + 单容器独立运行）

选一个目录作为**容器数据根目录**（下称 `$STACK_DIR`，即面板的 `WORK_DIR`）。采用 docker compose 官方的 `include:` 机制：主 `compose.yml` 只汇总各容器，每个容器有自己独立、自包含的 `compose.yml`。

```
$STACK_DIR/                 ← 容器数据根目录（WORK_DIR）
├── compose.yml             ← 主文件：networks + include 列表（不含 services）
│     networks: { D_Home: { external: true } }
│     include:
│       - composemgt/compose.yml   ← 基础服务，固定第一项
│       - alist/compose.yml
│       - postgres/compose.yml
├── .env                    ← 全局变量（TS_HOST_IP / SUBNET_PREFIX / TZ）
├── composemgt/
│   ├── compose.yml         ← 面板自身，自包含（build: ./manager, IP .254, 端口 65535）
│   ├── .env
│   └── manager/
├── alist/
│   ├── compose.yml         ← 自包含 → cd alist && docker compose up -d
│   ├── .env                ← 该容器变量 + 全局插值变量
│   └── data/
└── <name>/
    ├── compose.yml
    ├── .env
    └── data/
```

- **集中管理**：面板在 `$STACK_DIR` 跑 `docker compose <cmd> <service>`，`include` 自动聚合所有容器。
- **单容器独立运行**：`cd $STACK_DIR/<name> && docker compose up -d`。
- **可迁移**：把 `<name>/` 目录整个拷到别处即可运行（目标机需有 `D_Home` 网络）。

### include 语义（关键）

- 被包含文件里的相对路径（`./data`、`build.context`、`env_file`）相对**该文件自己的目录**解析。
- `${变量}` 插值：以**该文件目录下的 `.env`** 作默认值，被外层项目环境覆盖。
  - 聚合模式：面板注入 `SUBNET_PREFIX/TS_HOST_IP` → 覆盖生效。
  - 独立模式：`cd <name> && docker compose up` 用 `<name>/.env` 的默认值（故每容器 `.env` 会补入全局插值变量）。

---

## 全新部署（deploy.sh）

在装有 docker 的主机上：

```bash
mkdir -p /root/data/docker && cd /root/data/docker
git clone <repository-url> composemgt      # 目录名保持 composemgt
cd composemgt
./deploy.sh
```

`deploy.sh` 交互式完成：询问 `$STACK_DIR` 与网络参数 → 生成全局 `.env` → 创建 `D_Home` 网络 → 生成 `composemgt/compose.yml`（自包含基础服务）与 include 式主 `compose.yml` → `docker compose up -d --build composemgt`。脚本幂等，已有文件不覆盖。

访问：`http://<TS_HOST_IP>:65535`

---

## 从旧的单一 compose.yml 迁移（migrate-to-include.sh）

如果你现有的是**单一** `compose.yml`（所有服务写在一个 `services:` 块里），用迁移脚本一键转换为 include 布局：

```bash
cd $STACK_DIR/composemgt
./migrate-to-include.sh
```

迁移过程（**非破坏、可回滚**）：

1. 备份原文件 → `compose.yml.monolithic.bak`（不覆盖已有备份）
2. 用 `{merge:true}` 展开 YAML 锚点（`<<: *service-base` 等），保留 `${SUBNET_PREFIX}` 字面量
3. 每个服务拆分到 `<name>/compose.yml`（自包含），并重写相对路径使其相对该容器目录（物理位置不变）
4. 每个 `<name>/.env` 补入全局插值变量（用于单独运行），不覆盖已有 app 变量
5. 生成新的 include 式主 `compose.yml`（composemgt 第一项，顺序沿用原顺序）
6. 有 docker 时自动用 `docker compose config --services` 校验迁移前后服务集一致

**回滚**：`cp compose.yml.monolithic.bak compose.yml`

> 面板兼容两种布局的**读取**：迁移前面板也能正常显示容器；迁移后才启用 include 式的增/删/改。

---

## 面板行为：每容器独立目录约定

通过面板「新增容器」时（include 布局下）：

### 映射目录

相对映射路径自动归到容器自己的目录，写进 `<name>/compose.yml` 时相对该目录：

| 输入 | 写入 `<name>/compose.yml` | 物理位置 |
|------|--------------------------|----------|
| `./data` | `./data` | `$STACK_DIR/<name>/data` |
| `./config.yaml` | `./config.yaml` | `$STACK_DIR/<name>/config.yaml` |
| `/root/data/dl` | `/root/data/dl`（不变） | 绝对路径视为共享/外部挂载 |

对应目录自动创建（目录挂载建目录，可写文件挂载创建父目录和占位文件），目录权限 `755`、文件权限 `644`。

只读文件挂载（例如 `${GROK2API_CONFIG:-./config.yaml}:/run/grok2api/config.yaml:ro`）不会生成空配置。保存、启动、重启或重建前，面板会检查源文件必须存在、是普通文件且非空；否则直接显示解析后的宿主机绝对路径并阻止操作。

相对路径始终以服务 ID 对应目录为基准。例如服务 ID 为 `g2api` 时，`./config.yaml` 指向 `$STACK_DIR/g2api/config.yaml`，不会指向 `$STACK_DIR/grok2api/config.yaml`。

### 环境变量

- **字面量变量**（不含 `$`）→ 写入 `$STACK_DIR/<name>/.env`，用 `env_file: [./.env]` 引用。
- **含 `$` 的变量**（如 `${LOG_LEVEL:-INFO}`）→ 保留在 `environment:` 内联段（`env_file` 不展开 `${VAR}`）。
- `<name>/.env` 还会带上全局插值变量（`SUBNET_PREFIX/TS_HOST_IP/TZ`），使容器能单独运行。

编辑容器时，面板自动合并 `env_file` + 内联 `environment` 读回表单，不丢变量。

> 注：因每容器 `.env` 含全局插值变量，容器运行时会多拿到 `SUBNET_PREFIX` 等环境变量（无害）。

---

## 基础服务保护（composemgt）

- `composemgt` 必须是 `include` 列表**第一项**，占用静态 IP `${SUBNET_PREFIX}.254`、外部端口 `65535`
- 不能通过普通容器表单编辑或删除
- 新增其它容器前会校验基础服务（存在 / 置顶 / IP / 端口 / 真实环境下 `docker compose config` 与 `D_Home` 网络可用）

`.254` 与 `65535` 为系统保留资源，不会分配给其它容器。

---

## 端口与 IP 自动分配

- **静态 IP**：优先用输入/粘贴值；否则从 `.100`→`.254`、再 `.2`→`.99` 顺序找空位（保留 `.254`）。
- **外部端口**：从 `100`→`1000` 顺序找空位（保留 `65535`）。

粘贴整段 compose 到「新增容器」时，会按当前 stack 的占用自动避让并回填。

---

## 自动初始化（面板启动时）

`manager/server.js` 启动时：生成缺失的全局 `.env`；遍历 include 列表（或旧的单一 services 块），为每容器在其自己目录下创建映射目录、补齐缺失的 `env_file` 占位（避免 `docker compose up` 因缺文件失败）。

---

## 单容器独立运行 / 迁移到另一台机器

```bash
# 独立起某个容器
cd $STACK_DIR/<name>
docker compose up -d

# 迁移到另一台 VPS
#  1. 目标机创建 D_Home 网络： docker network create --subnet 172.18.0.0/24 D_Home
#  2. 拷贝整个 <name>/ 目录过去
#  3. cd <name> && docker compose up -d
```

---

## 故障排查

### 容器名冲突（container name is already in use）
```bash
docker rm -f <container_name>
docker compose up -d --force-recreate --remove-orphans <服务名>
```

### 基础服务配置异常
- `composemgt 不存在` → 检查 include 列表是否含 `composemgt/compose.yml` 且为第一项
- `必须使用 .254 / 65535` → 检查 `composemgt/compose.yml` 的 IP 与端口

### `missing config` / 只读配置挂载无效

先确认 Docker 最终使用的宿主机源路径：

```bash
docker inspect <容器名> --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

若服务 ID 与现有目录名不同，请把配置复制到 `$STACK_DIR/<服务ID>/`，或在面板中填写现有配置文件的绝对路径。修改 volume 后必须执行“重建”，普通重启不会更新挂载。

### 「拉取重建」报不是 Git 仓库
面板从构建上下文（如 `composemgt/manager`）向上查找 `.git`。确保项目是 `git clone` 获得。

### 修改了 server.js / 前端后不生效
容器内代码是构建时打包的，必须重建镜像：
```bash
cd $STACK_DIR
docker compose up -d --force-recreate --build composemgt
```
浏览器再按 `Ctrl+Shift+R` 强制刷新。

---

## 权限说明

| 对象 | 权限 | 所有者 |
|------|------|--------|
| 目录 | `755` | root |
| `.env` 文件 | `644` | root |

---

## 已知限制

- **WebDAV 备份**目前只备份主 `compose.yml`；include 布局下每容器文件与 `.env` 需另行备份（后续改进项）。
- 服务名与其数据目录名不一致时（如服务 `cpa` 用 `cliproxyapi/` 目录），迁移会用 `../` 相对路径保持物理位置不变，功能正常但不完全自包含在本目录内。
