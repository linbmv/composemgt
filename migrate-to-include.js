#!/usr/bin/env node
/**
 * migrate-to-include.js
 *
 * 非破坏地把「单一 compose.yml」拆成 include 布局：
 *   $STACK_DIR/compose.yml          -> networks + include 列表
 *   $STACK_DIR/<name>/compose.yml   -> 每容器自包含（可单独运行）
 *   $STACK_DIR/<name>/.env          -> 补入全局插值变量（standalone 用）
 *
 * - 备份原文件到 compose.yml.monolithic.bak（不覆盖已有备份）
 * - 用 {merge:true} 展开 YAML 锚点，保留 ${VAR} 字面量
 * - 重写相对路径，使其相对每容器目录（physical 位置不变）
 * - 保留每个服务原有的 environment / env_file（不拆分，最大限度保证等价）
 *
 * 用法：
 *   WORK_DIR=/root/data/docker node migrate-to-include.js [--force]
 * 或经 migrate-to-include.sh 包装运行。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require(path.join(__dirname, 'manager', 'node_modules', 'yaml'));

const WORK_DIR = process.env.WORK_DIR || process.cwd();
const COMPOSE_FILE = process.env.COMPOSE_FILE_PATH || path.join(WORK_DIR, 'compose.yml');
const ENV_FILE = process.env.ENV_FILE_PATH || path.join(WORK_DIR, '.env');
const BASE_SERVICE_NAME = 'composemgt';
const FORCE = process.argv.includes('--force');

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function readGlobalVars() {
  const out = { TS_HOST_IP: '100.101.102.100', SUBNET_PREFIX: '172.18.0', TZ: 'Asia/Shanghai' };
  // Simple .env parse (KEY=VALUE per line)
  try {
    if (fs.existsSync(ENV_FILE)) {
      for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        const i = s.indexOf('=');
        if (i === -1) continue;
        out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
      }
    }
  } catch (e) { /* ignore */ }
  return { TS_HOST_IP: out.TS_HOST_IP, SUBNET_PREFIX: out.SUBNET_PREFIX, TZ: out.TZ };
}

// Rewrite a "./X" host path (relative to $STACK_DIR) to be relative to <name>/.
function rewriteHostPath(hostPath, name) {
  if (typeof hostPath !== 'string' || !hostPath.startsWith('./')) return hostPath;
  const x = hostPath.slice(2).replace(/^\/+/, '');
  let rel = path.posix.relative(name, x);
  if (rel === '') rel = '.';
  return rel.startsWith('.') ? rel : './' + rel;
}

function rewriteVolumeEntry(entry, name) {
  if (typeof entry !== 'string') return entry;
  const idx = entry.indexOf(':');
  if (idx === -1) return entry;
  const host = entry.slice(0, idx);
  const rest = entry.slice(idx);
  return rewriteHostPath(host, name) + rest;
}

function rewriteEnvFile(ef, name) {
  if (typeof ef === 'string') return rewriteHostPath(ef, name);
  if (Array.isArray(ef)) return ef.map(e => (typeof e === 'string' ? rewriteHostPath(e, name) : e));
  return ef;
}

function rewriteBuild(build, name) {
  if (typeof build === 'string') return rewriteHostPath(build, name);
  if (build && typeof build === 'object' && typeof build.context === 'string') {
    return { ...build, context: rewriteHostPath(build.context, name) };
  }
  return build;
}

// Collect named volumes a service references (host side without './' or '/').
function referencedNamedVolumes(svc, topLevelVolumes) {
  const used = new Set();
  const names = new Set(Object.keys(topLevelVolumes || {}));
  if (Array.isArray(svc.volumes)) {
    for (const v of svc.volumes) {
      if (typeof v !== 'string') continue;
      const host = v.split(':')[0];
      if (host && !host.startsWith('.') && !host.startsWith('/') && names.has(host)) {
        used.add(host);
      }
    }
  }
  return [...used];
}

function main() {
  if (!fs.existsSync(COMPOSE_FILE)) die(`未找到 ${COMPOSE_FILE}`);

  const raw = fs.readFileSync(COMPOSE_FILE, 'utf8');
  const doc = YAML.parse(raw, { merge: true });

  if (Array.isArray(doc && doc.include) && doc.include.length > 0) {
    die('compose.yml 已经是 include 布局，无需迁移。');
  }
  const services = (doc && doc.services) || {};
  const serviceNames = Object.keys(services);
  if (serviceNames.length === 0) die('compose.yml 里没有 services。');

  const topNetworks = (doc && doc.networks) || { D_Home: { external: true } };
  const topVolumes = (doc && doc.volumes) || null;
  const globals = readGlobalVars();

  // 1. Backup (never overwrite an existing backup)
  const backup = COMPOSE_FILE + '.monolithic.bak';
  if (fs.existsSync(backup) && !FORCE) {
    die(`备份已存在: ${backup}（如确认要重新迁移，先删除它或加 --force）`);
  }
  fs.writeFileSync(backup, raw, 'utf8');
  console.log(`💾 已备份原文件 -> ${path.basename(backup)}`);

  // 2. Split each service into its own file
  const includeList = [];
  for (const name of serviceNames) {
    const svc = JSON.parse(JSON.stringify(services[name])); // deep clone, drop __baseDir

    if (svc.build) svc.build = rewriteBuild(svc.build, name);
    if (Array.isArray(svc.volumes)) svc.volumes = svc.volumes.map(v => rewriteVolumeEntry(v, name));
    if (svc.env_file) svc.env_file = rewriteEnvFile(svc.env_file, name);

    const serviceDir = path.join(WORK_DIR, name);
    fs.mkdirSync(serviceDir, { recursive: true, mode: 0o755 });

    // Self-contained doc: services + networks (+ named volumes it uses)
    const outDoc = { services: { [name]: svc } };
    const usesDHome = svc.networks && !Array.isArray(svc.networks) &&
      (svc.networks.D_Home || svc.networks.d_home);
    if (usesDHome || svc.network_mode !== 'host') {
      outDoc.networks = { D_Home: { external: true } };
    }
    const namedVols = referencedNamedVolumes(svc, topVolumes);
    if (namedVols.length > 0) {
      outDoc.volumes = {};
      for (const nv of namedVols) outDoc.volumes[nv] = (topVolumes && topVolumes[nv]) || null;
    }

    const header = `# ${name} —— 由 ComposeMgt 管理\n# 可单独运行： cd ${name} && docker compose up -d\n`;
    fs.writeFileSync(path.join(serviceDir, 'compose.yml'), header + YAML.stringify(outDoc), 'utf8');

    // Ensure <name>/.env carries the global interpolation vars (standalone),
    // merging into any existing app .env without clobbering existing keys.
    const envPath = path.join(serviceDir, '.env');
    const existing = {};
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        const i = s.indexOf('=');
        if (i !== -1) existing[s.slice(0, i).trim()] = s.slice(i + 1).trim();
      }
    }
    let changed = false;
    for (const [k, v] of Object.entries(globals)) {
      if (!(k in existing)) { existing[k] = v; changed = true; }
    }
    if (changed || !fs.existsSync(envPath)) {
      const content = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o644 });
    }

    includeList.push(`${name}/compose.yml`);
    console.log(`  ✓ ${name}/compose.yml`);
  }

  // 3. Ensure composemgt is first in the include list
  includeList.sort((a, b) => {
    if (a.startsWith(BASE_SERVICE_NAME + '/')) return -1;
    if (b.startsWith(BASE_SERVICE_NAME + '/')) return 1;
    return 0;
  });

  // 4. Write the new main compose.yml (networks + include [+ top volumes])
  const mainDoc = { networks: topNetworks };
  if (topVolumes) mainDoc.volumes = topVolumes;
  mainDoc.include = includeList;
  const mainHeader =
    '# ===================================================================================\n' +
    '#   主编排文件（include 布局，由 ComposeMgt 管理）\n' +
    '#   每个容器的定义在各自的 <name>/compose.yml 中，可单独运行。\n' +
    '#   composemgt 为基础服务，固定第一项，请勿删除。\n' +
    '# ===================================================================================\n';
  fs.writeFileSync(COMPOSE_FILE, mainHeader + YAML.stringify(mainDoc), 'utf8');

  console.log(`\n✅ 迁移完成：${serviceNames.length} 个服务已拆分为 include 布局。`);
  console.log(`   主文件： ${COMPOSE_FILE}`);
  console.log(`   回滚：   cp ${path.basename(backup)} compose.yml`);
  console.log(`\n下一步校验（需 docker）：`);
  console.log(`   docker compose -f ${path.basename(backup)} config --services | sort > /tmp/before.txt`);
  console.log(`   docker compose config --services | sort > /tmp/after.txt`);
  console.log(`   diff /tmp/before.txt /tmp/after.txt   # 应无差异`);
}

main();
