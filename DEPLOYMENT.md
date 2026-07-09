# ComposeMgt 部署指南

## 全新部署保证

本项目已实现**全自动初始化**，确保在全新部署时所有必要的文件和目录都能正确生成，并具有正确的权限。

## 自动初始化机制

### 启动时初始化

当 `manager/server.js` 启动时，会自动执行以下初始化操作：

1. **创建 data 目录**
   - 如果 `data/` 目录不存在，会自动创建
   - 权限：`755` (drwxr-xr-x)

2. **生成默认 .env 文件**
   - 路径：`data/.env`
   - 如果不存在，会从模板自动生成
   - 包含所有必需的环境变量：
     - `TS_HOST_IP`: Tailscale 主机 IP (默认 100.101.102.100)
     - `SUBNET_PREFIX`: Docker 网络子网前缀 (默认 172.18.0)
     - `TZ`: 时区 (默认 Asia/Shanghai)
     - `POSTGRES_PASSWORD`: PostgreSQL 密码
     - `HCA_ADMIN_PASSWORD`: HCA Family 管理密码
     - Grok2API 相关配置
   - 权限：`644` (-rw-r--r--)

3. **扫描并创建现有容器的数据目录**
   - 自动扫描 `data/compose.yml` 中所有服务的 volumes 配置
   - 为所有以 `./` 开头的相对路径挂载创建目录
   - 示例：
     ```yaml
     volumes:
       - './postgres/data:/var/lib/postgresql/data/pgdata'
     ```
     会自动创建 `postgres/data/` 目录
   - 权限：`755` (drwxr-xr-x)

### 新增容器时的目录创建

当通过管理面板新增容器时，系统会：

1. **自动创建容器的数据目录**
   - 在保存到 `compose.yml` 之前，先创建所有 volume 挂载目录
   - 支持目录挂载和文件挂载：
     - 目录挂载：创建完整目录路径
     - 文件挂载：创建父目录（不创建文件本身）

2. **示例**：
   ```json
   {
     "name": "myapp",
     "volumes": [
       "./myapp/data:/data",
       "./myapp/logs:/logs",
       "./myapp/config.yaml:/etc/config.yaml"
     ]
   }
   ```
   会自动创建：
   - `myapp/data/` (目录)
   - `myapp/logs/` (目录)
   - `myapp/` (config.yaml 的父目录)

## 部署步骤

### 方式一：Docker Compose 部署（推荐）

```bash
# 1. 克隆或下载项目
git clone <repository-url>
cd composemgt

# 2. 创建 Docker 网络（如果不存在）
docker network create --subnet=172.18.0.0/16 D_Home

# 3. 启动管理面板
docker compose up -d

# 4. 访问管理面板
# 浏览器打开：http://100.101.102.100:65535
# 或本地访问：http://localhost:65535
```

### 方式二：直接运行 Node.js

```bash
# 1. 安装依赖
cd manager
npm install

# 2. 启动服务
cd ..
node manager/server.js

# 3. 访问管理面板
# 浏览器打开：http://localhost:9988
```

## 目录结构

```
composemgt/
├── data/                      # 配置文件目录
│   ├── .env                   # 环境变量（自动生成）
│   ├── .env.example           # 环境变量示例
│   └── compose.yml            # 容器编排配置
├── manager/                   # 管理面板
│   ├── public/                # 前端静态文件
│   └── server.js              # 后端服务
├── docker-compose.yaml        # 管理面板部署配置
├── postgres/                  # PostgreSQL 数据目录（自动创建）
├── cliproxyapi/               # CLI Proxy API 数据目录（自动创建）
├── octopus/                   # Octopus 数据目录（自动创建）
├── grok2api/                  # Grok2API 数据目录（自动创建）
├── trilium/                   # Trilium 数据目录（自动创建）
├── metube/                    # MeTube 数据目录（自动创建）
├── arialist/                  # Alist 数据目录（自动创建）
├── awcaio/                    # AWC AIO 数据目录（自动创建）
├── hcafamily/                 # HCA Family 数据目录（自动创建）
├── microbin/                  # Microbin 数据目录（自动创建）
└── anylisten/                 # AnyListen 数据目录（自动创建）
```

## 权限说明

所有自动创建的文件和目录权限：

- **目录**: `755` (drwxr-xr-x) - 所有者可读写执行，其他用户可读执行
- **.env 文件**: `644` (-rw-r--r--) - 所有者可读写，其他用户只读
- **所有者**: root (UID 0, GID 0)

这些权限设置确保：
- Docker 容器可以访问挂载的数据目录
- 环境变量文件不会被意外修改
- 安全性和可用性之间的平衡

## 基础服务保护

项目强制要求 `composemgt` 服务存在于 `data/compose.yml` 的第一位，并占用：
- 静态 IP: `${SUBNET_PREFIX}.254` (默认 172.18.0.254)
- 外部端口: `65535`

在添加其他容器之前，系统会校验基础服务配置是否正确。这确保管理面板自身始终可访问。

## 端口和 IP 分配规则

### 静态 IP 分配
- 保留 IP: `.254` (管理面板)
- 自动分配范围: `.100` ~ `.254`、`.2` ~ `.99`
- 新增容器时自动选择未占用的 IP 尾数

### 端口分配
- 保留端口: `65535` (管理面板)
- 自动分配范围: `100` ~ `1000`
- 新增容器时自动选择未占用的端口

## 故障排查

### 问题：容器无法启动
```bash
# 检查日志
docker compose logs -f <服务名>

# 检查目录权限
ls -la <容器数据目录>

# 手动创建目录（如果自动创建失败）
mkdir -p <容器数据目录>
chmod 755 <容器数据目录>
```

### 问题：环境变量未生效
```bash
# 检查 .env 文件是否存在
cat data/.env

# 手动创建（如果丢失）
cp data/.env.example data/.env
# 然后编辑 data/.env 填入实际值
```

### 问题：权限拒绝
```bash
# 检查目录所有者
ls -la <目录>

# 修改所有者为 root（如果需要）
chown -R root:root <目录>
chmod -R 755 <目录>
```

## 安全建议

1. **修改默认密码**
   - 编辑 `data/.env`
   - 修改 `POSTGRES_PASSWORD`、`HCA_ADMIN_PASSWORD` 等
   - 重启相关容器使配置生效

2. **限制网络访问**
   - 使用 Tailscale 或防火墙限制访问来源
   - 不要将管理面板端口 (65535) 暴露到公网

3. **定期备份**
   - 备份 `data/compose.yml`
   - 备份 `data/.env`
   - 备份所有容器数据目录

## 更新和维护

```bash
# 1. 备份当前配置
cp data/compose.yml data/compose.yml.bak
cp data/.env data/.env.bak

# 2. 拉取最新代码
git pull

# 3. 重启管理面板
docker compose restart

# 4. 更新单个容器
docker compose pull <服务名>
docker compose up -d <服务名>
```

## 技术支持

如遇到问题：
1. 查看管理面板日志：`docker compose logs -f composemgt`
2. 查看容器日志：`docker compose logs -f <服务名>`
3. 检查系统初始化日志中的 `Creating` 和 `Created` 消息
