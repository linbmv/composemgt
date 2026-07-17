# 容器 tar 备份/恢复功能 — 测试清单

## 实现摘要

为 ComposeMgt 新增了**单容器整机备份/异地迁移**功能：

- **备份**：把一个容器的 `<name>/` 目录（compose.yml + .env + 绑定挂载数据）+ 所有命名卷内容，打成一个 `.tar.gz` 下载
- **恢复**：上传该 `.tar.gz` 到面板，自动重建容器目录、重建并回填所有命名卷、注册到 include 列表（include 模式下）
- **跨机迁移**：备份文件可以在任意一台部署了 ComposeMgt 的机器上恢复

## 文件改动

1. **manager/server.js**
   - 新增 helper：`runLong(cmd, timeout)` — 长超时执行器（默认 1 小时，用于大数据卷备份/恢复）
   - 新增 helper：`getServiceNamedVolumeMounts(containerName)` — 读取运行中容器的命名卷挂载列表
   - 新增端点：`GET /api/services/:name/backup` — 流式返回该容器的 `.tar.gz` 备份（Content-Disposition 触发浏览器下载）
   - 新增端点：`POST /api/services/restore?overwrite=0|1` — 接收原始 `.tar.gz` 上传流，解包恢复容器

2. **manager/public/app.js**
   - 新增函数：`triggerBackup(serviceName)` — 用隐藏 iframe 导航到 `/api/services/:name/backup`，触发下载
   - 容器卡片新增「备份」按钮（非基础服务 composemgt）
   - 设置页新增恢复上传 handler：`input-restore-container` change 事件，上传 tar.gz 到 `/api/services/restore`

3. **manager/public/index.html**
   - 设置页新增「容器整机备份 / 迁移」卡片（上传按钮 + 覆盖同名容器 checkbox + 状态提示 div）

## 备份包结构

一个容器备份 `<name>-backup-YYYYMMDDHHMMSS.tar.gz` 内部包含：

```
manifest.json           # 元数据：{ tool, kind, version, name, containerName, mode, volumes[], hasTree, createdAt }
compose.yml             # 该容器自己的 compose 文件副本（便于独立恢复）
tree.tar                # <name>/ 目录的 tar（compose.yml + .env + bind挂载数据）[include模式存在]
volumes/
  <volume-name-1>.tar   # 第一个命名卷的内容 tar
  <volume-name-2>.tar   # 第二个命名卷的内容 tar
  ...
```

**技术细节**：
- 目录部分（`tree.tar`）直接从面板的身份挂载 `$STACK_DIR/<name>/` 读取
- 命名卷部分用 alpine helper 容器（挂载 docker socket + 所有目标卷）逐个 `tar -cf` 打包
- 最外层用 `tar -czf` 压缩成单个 gzip 流，直接 pipe 到 HTTP response

## 测试步骤（在有 docker 的主机上执行）

### 前提：重建面板容器应用代码更新

```bash
cd /root/data/docker  # 或你的 $STACK_DIR
docker compose up -d --build composemgt
docker compose logs -f composemgt  # 确认启动无报错
```

### 测试 1：备份一个有命名卷的容器

1. 访问面板 `http://<TS_HOST_IP>:65535`，选一个**有命名卷**的容器（如 `grok2api`，它有 `grok2api-data` 卷）
2. 点击容器卡片的「**备份**」按钮
3. 观察：
   - 浏览器自动弹出下载对话框（文件名类似 `grok2api-backup-20260717123456.tar.gz`）
   - 面板顶部有提示：「正在打包容器 grok2api（目录 + 命名卷），大数据卷可能需要一些时间，请稍候...」
4. 下载完成后，用 `tar -tzf <备份文件>.tar.gz | head -20` 查看内部结构，应包含：
   - `manifest.json`
   - `compose.yml`
   - `tree.tar`（如果是 include 模式）
   - `volumes/<卷名>.tar`

**预期结果**：✅ 下载成功，tar 包结构完整。

### 测试 2：恢复到同一台机器（覆盖模式）

1. 进入「**备份与系统设置**」标签页
2. 找到「**容器整机备份 / 迁移**」卡片
3. **勾选**「覆盖已有同名容器」
4. 点「📦 上传备份并恢复容器」，选刚才下载的 `.tar.gz`
5. 确认弹窗
6. 观察：
   - 状态提示区显示「⏳ 正在上传并恢复，请稍候（大数据可能需要几分钟）...」
   - 顶部弹出成功提示：「🎉 已恢复容器 "grok2api"（N 个命名卷）」
   - 容器列表自动刷新，该容器出现
7. 验证：
   ```bash
   docker volume ls | grep grok2api-data  # 命名卷存在
   ls -la /root/data/docker/grok2api/     # 目录存在，含 compose.yml、.env
   docker compose config --services | grep grok2api  # 在 include 列表中
   ```

**预期结果**：✅ 恢复成功，容器目录 + 命名卷 + include 注册全部到位。

### 测试 3：跨机迁移（新建模式）

1. 准备另一台 VPS（或虚拟机），部署 ComposeMgt（用 `./deploy.sh`）
2. **不要**在新机器上手动创建同名容器
3. 把测试 1 的备份文件上传到新机器的面板（**不勾选**「覆盖已有同名容器」）
4. 观察恢复成功后：
   ```bash
   docker volume ls                       # 命名卷已创建
   ls /root/data/docker/<name>/           # 目录存在
   grep "<name>/compose.yml" /root/data/docker/compose.yml  # include 列表已注册
   ```
5. 在容器卡片点「启动」，或执行 `docker compose up -d <name>`
6. 验证容器运行正常：`docker compose ps <name>`、`docker compose logs <name>`

**预期结果**：✅ 异地恢复成功，容器能正常启动。

### 测试 4：恢复已存在容器（不覆盖）

1. 上传一个备份文件，其容器名已存在于当前 stack
2. **不勾选**「覆盖已有同名容器」
3. 点上传

**预期结果**：❌ 面板拒绝恢复，提示「服务 "xxx" 已存在。如需覆盖，请勾选「覆盖已有同名容器」后重试。」

### 测试 5：备份基础服务 composemgt

1. 在容器列表找到 `composemgt` 卡片
2. 观察：该卡片**没有**「备份」按钮（只有「日志」和「拉取重建」）

**预期结果**：✅ 基础服务不可在线备份（提示需在主机手动打包）。

### 测试 6：大数据卷备份/恢复耐久性

1. 准备一个有 > 1GB 数据的命名卷容器（如填满数据的 postgres）
2. 备份该容器
3. 观察备份过程：
   - 不会因 15 秒超时被杀（用了 `runLong` 替代 `runCommand`）
   - 下载的 `.tar.gz` 体积与数据量相符
4. 恢复该备份到另一台机器
5. 验证数据完整性（进容器检查文件/数据库内容）

**预期结果**：✅ 大数据卷备份/恢复成功，无超时，数据完整。

## 边界情况

| 场景 | 预期行为 |
|------|---------|
| 容器无命名卷（只有 bind 挂载） | 备份只含 `tree.tar` + `manifest.json`，恢复正常 |
| 容器已停止/删除 | 备份从 compose 定义推断卷列表；恢复重建目录 + 卷 |
| 演示模式（无 docker） | 备份/恢复端点返回 400「演示模式，无法执行」 |
| 上传非 ComposeMgt 导出的 tar | 恢复失败：「备份缺少 manifest.json，可能不是本工具导出的容器备份」 |
| 恢复时 `<name>/` 目录已存在但为空 | 被 `tree.tar` 覆盖；卷内容被覆盖（覆盖模式） |
| 备份时卷名含特殊字符 | 卷名校验：`VALID_SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/`，非法卷跳过 |

## 已知限制

1. **composemgt 自身不支持在线备份**：因为备份过程本身依赖面板运行，鸡生蛋问题。建议在主机手动 `tar -czf composemgt-backup.tar.gz composemgt/`。
2. **WebDAV 自动备份未集成**：当前只备份主 `compose.yml`；容器 tar 备份需手动下载。后续可改进为「定时自动备份所有容器到 WebDAV」。
3. **恢复不校验依赖**：如果容器依赖另一个服务（如 `depends_on: db`），恢复时不自动拉起依赖，需手动按依赖顺序恢复。
4. **大卷超时风险**：虽然用了 1 小时超时，但极端大卷（> 100GB）仍可能超时。建议分批备份或在主机用 `docker run` + `docker cp` 手动打包。

## 回滚计划

如果测试失败需要回滚：

```bash
cd /root/data/docker/composemgt
git checkout HEAD~1 manager/server.js manager/public/app.js manager/public/index.html
cd /root/data/docker
docker compose up -d --build composemgt
```

## 提交记录

实现完整的容器 tar 备份/恢复功能：
- 后端新增 `/api/services/:name/backup` 和 `/api/services/restore`
- 前端容器卡片新增「备份」按钮，设置页新增恢复上传 UI
- 支持命名卷 + 绑定挂载目录的完整打包，异地可重建
