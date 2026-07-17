const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const YAML = require('yaml');
const dotenv = require('dotenv');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from 'public' directory with caching disabled
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

const COMPOSE_FILE_PATH = process.env.COMPOSE_FILE_PATH || path.resolve(__dirname, '../data/compose.yml');
const ENV_FILE_PATH = process.env.ENV_FILE_PATH || path.resolve(__dirname, '../data/.env');
const WORK_DIR = process.env.WORK_DIR || path.dirname(COMPOSE_FILE_PATH);
// Persisted panel state (webdav config, custom commands). Kept UNDER WORK_DIR so
// it survives container rebuilds via the identity mount — NOT under __dirname
// (that lives inside the image and is wiped on every rebuild).
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(WORK_DIR, '.composemgt');
const BASE_SERVICE_NAME = 'composemgt';
const BASE_SERVICE_IP_SUFFIX = 254;
const BASE_SERVICE_PUBLISHED_PORT = 65535;
const BASE_SERVICE_TARGET_PORT = 9988;

// Mock Mode Status (Enables mock mode if Docker is not available in system)
let isMockMode = false;
let mockState = {}; // In-memory state for mock mode

// Verify Docker and Docker Compose availability
function checkDockerAvailability() {
  return new Promise((resolve) => {
    exec('docker compose version', (err, stdout) => {
      if (err) {
        console.warn('⚠️ Docker Compose not found in system PATH. Enabling Mock/Demo Mode.');
        isMockMode = true;
        resolve(false);
      } else {
        console.log(`✅ Docker Compose found: ${stdout.trim()}`);
        isMockMode = false;
        resolve(true);
      }
    });
  });
}

// Read env variables
function getEnvVariables() {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    return {};
  }
  const content = fs.readFileSync(ENV_FILE_PATH, 'utf8');
  return dotenv.parse(content);
}

// Save env variables
function saveEnvVariables(envObj) {
  let content = '';
  for (const [key, value] of Object.entries(envObj)) {
    content += `${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE_PATH, content, 'utf8');
}

function getCommandEnv() {
  const envs = getEnvVariables();
  return {
    ...process.env,
    TS_HOST_IP: '100.101.102.100',
    SUBNET_PREFIX: '172.18.0',
    TZ: 'Asia/Shanghai',
    ...envs
  };
}

// Run exec command wrapped in Promise
function runCommand(command) {
  return new Promise((resolve, reject) => {
    // Enforce a 15-second timeout to prevent hanging commands from blocking the backend
    exec(command, { cwd: WORK_DIR, timeout: 15000, env: getCommandEnv() }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          reject('命令运行超时（15秒限制），已被系统强行终止。请检查该指令是否在等待交互输入，或者包含持续输出/跟踪参数（如 -f ）。\n' + stdout + stderr);
        } else {
          reject(error.message + '\n' + stderr);
        }
      } else {
        // Docker logs write to stderr, so combine both streams
        resolve(stdout + stderr);
      }
    });
  });
}

// composemgt manages itself. Lifecycle/update commands issued from inside the
// panel would kill the very process serving the request (docker recreates the
// container mid-command), and can leave the panel half-recreated. So these are
// refused for the base service with instructions to run them on the host.
function baseServiceSelfOpGuard(res, action) {
  return res.status(400).json({
    error:
      `composemgt 是管理面板自身，不能从面板内部「${action}」——这会中断面板进程，可能导致面板无法自动恢复。\n\n` +
      `请在主机执行（一条命令完成拉取代码 + 重建）：\n` +
      `  cd ${WORK_DIR} && git -C composemgt pull && docker compose up -d --force-recreate --build composemgt`
  });
}

// One-click background self-update for the panel itself.
//
// The panel cannot rebuild itself in-process (recreating its own container
// kills the request). Instead we launch an INDEPENDENT throw-away container via
// the docker socket, using the panel's own image (which has git + docker
// compose). That helper sleeps briefly (so the HTTP response flushes), then runs
// `git pull` + `docker compose up -d --force-recreate --build composemgt`.
// Being its own container, it survives while composemgt is destroyed/recreated.
async function launchSelfUpdate() {
  const cmdEnv = getCommandEnv();

  // Determine the panel's own image (docker sets hostname = container id).
  const selfId = os.hostname();
  let imageRef = '';
  try {
    imageRef = (await runCommand(`docker inspect --format '{{.Image}}' ${selfId}`)).trim();
  } catch (e) {
    throw new Error(`无法确定面板自身镜像（docker inspect ${selfId} 失败）：${e}`);
  }
  if (!imageRef) throw new Error('无法确定面板自身镜像（inspect 返回空）。');

  // Write the update script into WORK_DIR (visible to the helper via the same
  // identity mount composemgt uses). The panel's source is at ./composemgt .
  const scriptPath = path.join(WORK_DIR, '.composemgt-selfupdate.sh');
  const logPath = path.join(WORK_DIR, '.composemgt-selfupdate.log');
  const script = `#!/bin/sh
sleep 3
{
  echo "=== self-update start ==="
  echo "[1/2] git -C composemgt pull ..."
  git -C composemgt pull || echo "(git pull skipped/failed; rebuilding with current local code)"
  echo "[2/2] docker compose up -d --force-recreate --build ${BASE_SERVICE_NAME} ..."
  docker compose up -d --force-recreate --build ${BASE_SERVICE_NAME}
  echo "=== self-update done ==="
} >> "${logPath}" 2>&1
`;
  fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o755 });

  const runCmd = [
    'docker run -d --rm',
    '-v /var/run/docker.sock:/var/run/docker.sock',
    `-v ${WORK_DIR}:${WORK_DIR}`,
    `-w ${WORK_DIR}`,
    `-e SUBNET_PREFIX=${cmdEnv.SUBNET_PREFIX}`,
    `-e TS_HOST_IP=${cmdEnv.TS_HOST_IP}`,
    `-e TZ=${cmdEnv.TZ}`,
    imageRef,
    `sh ${scriptPath}`
  ].join(' ');

  const helperId = (await runCommand(runCmd)).trim();
  return { helperId, imageRef, logPath };
}

// ===================================================================================
//  Per-container tar backup / restore
//  A backup is one .tar.gz holding:
//    manifest.json         — { name, mode, containerName, volumes[], hasTree }
//    tree.tar              — the container's own $STACK_DIR/<name>/ directory
//                            (compose.yml + .env + bind-mounted data)   [include mode]
//    service.yml           — the single service definition               [legacy fallback]
//    volumes/<real>.tar    — one tar per NAMED docker volume's content
//  Named volumes live in Docker's volume store (not under <name>/), so they are
//  captured/restored through short-lived alpine helper containers over the socket.
// ===================================================================================

const VALID_SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// exec with a long timeout + large buffer, for tar/volume operations that may
// move gigabytes. cwd/env match runCommand so `docker compose` resolves the stack.
function runLong(command, timeoutMs = 3600000) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: WORK_DIR, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: getCommandEnv() },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) reject(new Error(`命令超时（${Math.round(timeoutMs / 1000)}s）被终止。\n${stdout}${stderr}`));
          else reject(new Error(error.message + '\n' + stderr));
        } else {
          resolve(stdout + stderr);
        }
      });
  });
}

// Inspect a container and return its NAMED-volume mounts as [{ name, destination }].
// bind mounts are excluded (they live under <name>/ and travel with tree.tar).
async function getServiceNamedVolumeMounts(containerName) {
  const out = await runCommand(
    `docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}::{{.Destination}}{{println}}{{end}}{{end}}' ${containerName}`
  );
  return out.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const i = l.indexOf('::');
      return { name: l.slice(0, i), destination: l.slice(i + 2) };
    })
    .filter(m => m.name && m.destination);
}

function normalizeEnvironment(environment) {
  if (!environment) return {};
  if (Array.isArray(environment)) {
    return environment.reduce((result, item) => {
      if (typeof item !== 'string') return result;
      const idx = item.indexOf('=');
      if (idx === -1) {
        result[item.trim()] = '';
      } else {
        result[item.slice(0, idx).trim()] = item.slice(idx + 1).trim();
      }
      return result;
    }, {});
  }
  if (typeof environment === 'object') {
    return Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [key, value === null || value === undefined ? '' : String(value)])
    );
  }
  return {};
}

function normalizeVolumes(volumes) {
  if (!Array.isArray(volumes)) return [];
  return volumes.map(volume => {
    if (typeof volume === 'string') return volume;
    if (volume && typeof volume === 'object') {
      if (volume.source && volume.target) {
        return `${volume.source}:${volume.target}${volume.read_only ? ':ro' : ''}`;
      }
      if (volume.target) return String(volume.target);
    }
    return '';
  }).filter(Boolean);
}

// Rewrite a relative host path to the active layout convention:
//  - include: relative to the container's OWN directory   -> ./data
//  - legacy:  under ./<name>/ relative to the docker root  -> ./<name>/data
// Absolute paths and named volumes are returned unchanged.
function conventionHostPath(hostPath, serviceName, mode) {
  if (typeof hostPath !== 'string' || !hostPath.startsWith('./')) return hostPath;
  let rel = hostPath.slice(2).replace(/^\/+/, '');
  const prefix = serviceName + '/';
  if (rel === serviceName) rel = '';
  else if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  if (mode === 'include') return rel ? './' + rel : '.';
  return rel ? './' + serviceName + '/' + rel : './' + serviceName;
}

// Split short volume syntax at the first colon outside a ${...} expression.
// A plain split/indexOf breaks values such as
// ${GROK2API_CONFIG:-./config.yaml}:/run/grok2api/config.yaml:ro.
function splitVolumeEntry(entry) {
  if (typeof entry !== 'string') return { source: '', targetAndMode: '', hasTarget: false };
  let interpolationDepth = 0;
  for (let i = 0; i < entry.length; i += 1) {
    if (entry[i] === '$' && entry[i + 1] === '{') {
      interpolationDepth += 1;
      i += 1;
      continue;
    }
    if (entry[i] === '}' && interpolationDepth > 0) {
      interpolationDepth -= 1;
      continue;
    }
    if (entry[i] === ':' && interpolationDepth === 0) {
      return {
        source: entry.slice(0, i),
        targetAndMode: entry.slice(i + 1),
        hasTarget: true
      };
    }
  }
  return { source: entry, targetAndMode: '', hasTarget: false };
}

function effectiveVolumeSource(source, interpolationEnv = {}) {
  if (typeof source !== 'string' || !source) return null;
  const variableMatch = source.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}(.*)$/);
  if (variableMatch) {
    const [, name, operator, defaultValue = '', suffix] = variableMatch;
    const hasValue = Object.prototype.hasOwnProperty.call(interpolationEnv, name);
    const value = hasValue ? String(interpolationEnv[name]) : '';
    if (!operator) return hasValue ? value + suffix : null;
    if (operator === ':-') return (hasValue && value !== '' ? value : defaultValue) + suffix;
    return (hasValue ? value : defaultValue) + suffix;
  }
  if (source.startsWith('${')) return null;
  return source;
}

function getVolumeInterpolationEnv(baseDir) {
  let localEnv = {};
  try {
    const localEnvPath = path.join(baseDir, '.env');
    if (fs.existsSync(localEnvPath)) {
      localEnv = dotenv.parse(fs.readFileSync(localEnvPath, 'utf8'));
    }
  } catch (error) {
    console.warn(`Failed to read interpolation env from ${baseDir}: ${error.message}`);
  }
  return { ...getCommandEnv(), ...localEnv };
}

function isReadOnlyVolumeTarget(targetAndMode) {
  if (typeof targetAndMode !== 'string') return false;
  const lastColon = targetAndMode.lastIndexOf(':');
  if (lastColon === -1) return false;
  return targetAndMode.slice(lastColon + 1).split(',').includes('ro');
}

// Apply conventionHostPath to the host side of a "host:container[:mode]" entry.
function conventionVolumeEntry(entry, serviceName, mode) {
  if (typeof entry !== 'string') return entry;
  const parsed = splitVolumeEntry(entry);
  if (!parsed.hasTarget) return entry;
  return `${conventionHostPath(parsed.source, serviceName, mode)}:${parsed.targetAndMode}`;
}

// Resolve a volume host-path string to a physical path suitable for pre-creation.
// Handles three real-world shapes found in production compose files:
//  1. Plain relative:   ./data              -> baseDir/data
//  2. Variable default: ${FOO:-./config.yaml} -> baseDir/config.yaml  (extract default)
//  3. Bare variable:    ${FOO}              -> null (can't know the path, skip)
// Absolute paths are returned for validation but are never auto-created by the
// callers. Named volumes and unresolvable expressions return null.
function resolveHostPathForCreation(hostPath, baseDir = WORK_DIR) {
  if (typeof hostPath !== 'string' || !hostPath) return null;
  const effective = effectiveVolumeSource(hostPath, getVolumeInterpolationEnv(baseDir));
  if (!effective) return null;
  // Now `effective` should be a real path expression.
  if (effective === '.' || effective.startsWith('./') || effective.startsWith('../')) {
    return path.resolve(baseDir, effective);
  }
  if (path.isAbsolute(effective)) {
    return effective;
  }
  // Bare name like "myvolume" — a named volume, don't create.
  return null;
}

// Given a resolved host path and the original path string (with trailing slash
// / extension hints), pre-create it as directory or empty file.
//  - Trailing slash or no extension -> directory mount
//  - Has file extension -> file mount (create parent dir + empty placeholder)
// Writable file mounts get an empty placeholder so Docker does not create a
// directory at that path. Read-only config files are validated separately and
// must already contain real configuration.
function ensureHostPathExists(fullPath, hostPathHint) {
  const looksLikeDir = hostPathHint.endsWith('/') || !path.extname(fullPath);
  if (looksLikeDir) {
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true, mode: 0o755 });
      return { created: true, kind: 'dir', path: fullPath };
    }
    return { created: false, kind: 'dir', path: fullPath };
  }
  // File mount: create parent dir, then create empty file if absent.
  const parent = path.dirname(fullPath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  }
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, '', { encoding: 'utf8', mode: 0o644 });
    return { created: true, kind: 'file', path: fullPath };
  }
  return { created: false, kind: 'file', path: fullPath };
}

function getReadOnlyFileMountError(serviceName, volumes, baseDir) {
  if (!Array.isArray(volumes)) return '';
  for (const volume of volumes) {
    let source = '';
    let targetAndMode = '';
    let readOnly = false;

    if (typeof volume === 'string') {
      const parsed = splitVolumeEntry(volume);
      if (!parsed.hasTarget) continue;
      source = parsed.source;
      targetAndMode = parsed.targetAndMode;
      readOnly = isReadOnlyVolumeTarget(targetAndMode);
    } else if (volume && typeof volume === 'object') {
      source = volume.source || '';
      readOnly = volume.read_only === true;
    }
    if (!readOnly) continue;

    const effectiveSource = effectiveVolumeSource(source, getVolumeInterpolationEnv(baseDir));
    const fullPath = resolveHostPathForCreation(source, baseDir);
    if (!effectiveSource || !fullPath) continue;
    if (effectiveSource.endsWith('/') || !path.extname(fullPath)) continue;

    let invalidReason = '';
    try {
      if (!fs.existsSync(fullPath)) {
        invalidReason = '文件不存在';
      } else {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) invalidReason = '该路径不是普通文件';
        else if (stat.size === 0) invalidReason = '文件为空';
      }
    } catch (error) {
      invalidReason = `无法读取：${error.message}`;
    }

    if (invalidReason) {
      return `只读配置挂载无效：${fullPath}（${invalidReason}）。`
        + ` 当前服务 ID 为 "${serviceName}"，相对路径会解析到 ${baseDir}；`
        + '请填写正确的绝对路径，或将有效配置文件放入该服务目录。';
    }
  }
  return '';
}

function assertServiceMountsReady(serviceName) {
  const entry = readAllServiceEntries().find(([name]) => name === serviceName);
  if (!entry) {
    const error = new Error(`未找到服务 "${serviceName}" 的 compose 配置。`);
    error.statusCode = 404;
    throw error;
  }
  const service = entry[1];
  const errorMessage = getReadOnlyFileMountError(
    serviceName,
    service.volumes || [],
    service.__baseDir || WORK_DIR
  );
  if (errorMessage) {
    const error = new Error(errorMessage);
    error.statusCode = 400;
    throw error;
  }
}

function serviceMountsReadyOrRespond(serviceName, res) {
  try {
    assertServiceMountsReady(serviceName);
    return true;
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
    return false;
  }
}

// Detect bare named-volume sources (e.g. "grok2api-data" in
// "grok2api-data:/app/data"). These MUST be declared in the top-level volumes:
// section or docker compose rejects the project ("refers to undefined volume").
// Bind mounts (/abs, ./rel, ../rel, ~) and ${VAR} interpolations are NOT named
// volumes and are skipped.
function extractNamedVolumes(volumes) {
  const names = [];
  if (!Array.isArray(volumes)) return names;
  for (const v of volumes) {
    if (typeof v !== 'string') continue;
    const parsed = splitVolumeEntry(v);
    if (!parsed.hasTarget || !parsed.source) continue;
    const src = parsed.source;
    if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(src)) names.push(src);
  }
  return names;
}

// The three global interpolation variables, copied into each container's own
// .env so `cd <name> && docker compose up` resolves ${SUBNET_PREFIX} etc.
function getGlobalInterpolationVars() {
  const e = getEnvVariables();
  return {
    TS_HOST_IP: e.TS_HOST_IP || '100.101.102.100',
    SUBNET_PREFIX: e.SUBNET_PREFIX || '172.18.0',
    TZ: e.TZ || 'Asia/Shanghai'
  };
}

// Read and merge any env_file(s) declared on a service so the panel can show
// the values back in the edit form. Paths are resolved relative to WORK_DIR,
// matching how docker compose resolves them.
function readEnvFilesForService(service, baseDir) {
  const result = {};
  if (!service || !service.env_file) return result;
  const base = baseDir || WORK_DIR;
  const files = Array.isArray(service.env_file) ? service.env_file : [service.env_file];
  for (const f of files) {
    if (typeof f !== 'string') continue;
    const p = path.isAbsolute(f) ? f : path.resolve(base, f);
    try {
      if (fs.existsSync(p)) {
        Object.assign(result, dotenv.parse(fs.readFileSync(p, 'utf8')));
      }
    } catch (e) {
      // ignore unreadable env files
    }
  }
  return result;
}

// ===================================================================================
//  include-mode helpers
//  The stack can be laid out two ways:
//   - legacy:  a single $STACK_DIR/compose.yml with a `services:` block
//   - include: $STACK_DIR/compose.yml with an `include:` list, plus one
//              $STACK_DIR/<name>/compose.yml per container (self-contained,
//              runnable standalone via `cd <name> && docker compose up -d`)
//  Reads are mode-aware so the panel works in both layouts; writes target the
//  include layout (falling back to legacy only when no include list exists).
// ===================================================================================

// Parse the main file's include list into [{ name, file }] (name = first path segment).
function parseIncludeEntries(includeArr) {
  if (!Array.isArray(includeArr)) return [];
  const out = [];
  for (const entry of includeArr) {
    let p = null;
    if (typeof entry === 'string') {
      p = entry;
    } else if (entry && typeof entry === 'object') {
      const raw = entry.path;
      p = Array.isArray(raw) ? raw[0] : raw;
    }
    if (typeof p !== 'string' || !p) continue;
    const norm = p.replace(/^\.\//, '');
    const name = norm.split('/')[0];
    out.push({ name, file: p });
  }
  return out;
}

// Detect the layout mode of the main compose file.
function getComposeMode() {
  try {
    if (!fs.existsSync(COMPOSE_FILE_PATH)) return 'legacy';
    const doc = YAML.parse(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'));
    if (Array.isArray(doc?.include) && doc.include.length > 0) return 'include';
    return 'legacy';
  } catch (e) {
    return 'legacy';
  }
}

// Absolute path of a container's own compose file (include layout).
function serviceComposePath(name) {
  return path.join(WORK_DIR, name, 'compose.yml');
}

// Base directory used to resolve a service's relative paths (env_file, volumes):
//  - include mode: the container's own folder ($STACK_DIR/<name>)
//  - legacy mode:  WORK_DIR
function serviceBaseDir(name, mode) {
  return (mode || getComposeMode()) === 'include' ? path.join(WORK_DIR, name) : WORK_DIR;
}

// Read every service across the stack, anchor-merge resolved, in declared order.
// Returns [[name, serviceObj], ...]; each serviceObj carries a non-enumerable
// __baseDir for downstream relative-path resolution.
function readAllServiceEntries() {
  if (!fs.existsSync(COMPOSE_FILE_PATH)) return [];
  let mainDoc;
  try {
    mainDoc = YAML.parse(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'), { merge: true });
  } catch (e) {
    console.warn(`Failed to parse main compose.yml: ${e.message}`);
    return [];
  }
  const entries = [];
  const tag = (obj, dir) => {
    if (obj && typeof obj === 'object') {
      Object.defineProperty(obj, '__baseDir', { value: dir, enumerable: false, configurable: true });
    }
  };
  if (Array.isArray(mainDoc?.include) && mainDoc.include.length > 0) {
    for (const { file } of parseIncludeEntries(mainDoc.include)) {
      const abs = path.isAbsolute(file) ? file : path.resolve(WORK_DIR, file);
      if (!fs.existsSync(abs)) continue;
      let sub;
      try {
        sub = YAML.parse(fs.readFileSync(abs, 'utf8'), { merge: true });
      } catch (e) {
        console.warn(`Failed to parse included compose ${file}: ${e.message}`);
        continue;
      }
      for (const [svcName, svcObj] of Object.entries(sub?.services || {})) {
        tag(svcObj, path.dirname(abs));
        entries.push([svcName, svcObj]);
      }
    }
  } else {
    for (const [svcName, svcObj] of Object.entries(mainDoc?.services || {})) {
      tag(svcObj, WORK_DIR);
      entries.push([svcName, svcObj]);
    }
  }
  return entries;
}

// Same data as an ordered plain object { name: serviceObj }.
function readAllServicesMap() {
  const map = {};
  for (const [name, obj] of readAllServiceEntries()) map[name] = obj;
  return map;
}

function normalizeComposePort(port) {
  if (typeof port === 'number') {
    return { published: port, target: port };
  }
  if (typeof port === 'string') {
    const withoutProtocol = port.split('/')[0];
    const parts = withoutProtocol.split(':');
    if (parts.length >= 2) {
      return {
        published: parseInt(parts[parts.length - 2]),
        target: parseInt(parts[parts.length - 1])
      };
    }
    const singlePort = parseInt(parts[0]);
    return { published: singlePort, target: singlePort };
  }
  if (port && typeof port === 'object') {
    return {
      published: port.published ? parseInt(port.published) : undefined,
      target: port.target ? parseInt(port.target) : undefined
    };
  }
  return {};
}

function getPublishedPort(port) {
  if (typeof port === 'object' && port !== null) {
    return port.published ? parseInt(port.published) : null;
  }
  if (typeof port === 'string') {
    const parts = port.split('/')[0].split(':');
    if (parts.length >= 2) return parseInt(parts[parts.length - 2]);
    if (parts.length === 1) return parseInt(parts[0]);
  }
  if (typeof port === 'number') return port;
  return null;
}

function getBaseServiceValidationError(services) {
  const entries = Object.entries(services || {});
  const baseEntryIndex = entries.findIndex(([name]) => name === BASE_SERVICE_NAME);
  if (baseEntryIndex === -1) {
    return `基础服务 "${BASE_SERVICE_NAME}" 不存在，请先初始化管理面板服务。`;
  }
  if (baseEntryIndex !== 0) {
    return `基础服务 "${BASE_SERVICE_NAME}" 必须位于 compose.yml 的 services 第一项。`;
  }

  const baseService = services[BASE_SERVICE_NAME];
  const baseNetworks = baseService.networks || {};
  const baseIpSuffix = !Array.isArray(baseNetworks) && baseNetworks.D_Home
    ? getIpSuffixFromAddress(baseNetworks.D_Home.ipv4_address)
    : null;
  if (baseIpSuffix !== BASE_SERVICE_IP_SUFFIX) {
    return `基础服务 "${BASE_SERVICE_NAME}" 必须使用静态 IP 尾数 .${BASE_SERVICE_IP_SUFFIX}。`;
  }

  const basePorts = Array.isArray(baseService.ports) ? baseService.ports : [];
  const hasBasePort = basePorts.some(port => getPublishedPort(port) === BASE_SERVICE_PUBLISHED_PORT);
  if (!hasBasePort) {
    return `基础服务 "${BASE_SERVICE_NAME}" 必须占用外部端口 ${BASE_SERVICE_PUBLISHED_PORT}。`;
  }

  for (const [serviceName, serviceConfig] of entries) {
    if (serviceName === BASE_SERVICE_NAME) continue;
    const networks = serviceConfig.networks || {};
    if (!Array.isArray(networks)) {
      for (const netConfig of Object.values(networks)) {
        if (getIpSuffixFromAddress(netConfig?.ipv4_address) === BASE_SERVICE_IP_SUFFIX) {
          return `静态 IP .${BASE_SERVICE_IP_SUFFIX} 已被服务 "${serviceName}" 占用，无法保留给基础服务。`;
        }
      }
    }
    if (Array.isArray(serviceConfig.ports)) {
      for (const port of serviceConfig.ports) {
        if (getPublishedPort(port) === BASE_SERVICE_PUBLISHED_PORT) {
          return `外部端口 ${BASE_SERVICE_PUBLISHED_PORT} 已被服务 "${serviceName}" 占用，无法保留给基础服务。`;
        }
      }
    }
  }

  return '';
}

async function assertBaseServiceDeployable(services) {
  const baseServiceError = getBaseServiceValidationError(services);
  if (baseServiceError) {
    throw new Error(`${baseServiceError} 请先修复基础服务后再新增其它容器。`);
  }

  if (isMockMode) return;

  const configuredServices = await runCommand('docker compose config --services');
  const serviceNames = configuredServices.split('\n').map(line => line.trim()).filter(Boolean);
  if (!serviceNames.includes(BASE_SERVICE_NAME)) {
    throw new Error(`docker compose config 未识别到基础服务 "${BASE_SERVICE_NAME}"，请检查 compose.yml。`);
  }

  await runCommand('docker network inspect D_Home');
}

function getIpSuffixFromAddress(address) {
  if (!address) return null;
  const parts = address.toString().split('.');
  const suffix = parseInt(parts[parts.length - 1].replace(/\}?$/, '').trim());
  return Number.isInteger(suffix) ? suffix : null;
}

function collectComposeUsage(services) {
  const usedPorts = new Set([BASE_SERVICE_PUBLISHED_PORT]);
  const usedIpSuffixes = new Set([BASE_SERVICE_IP_SUFFIX]);

  for (const service of Object.values(services || {})) {
    if (Array.isArray(service.ports)) {
      service.ports.forEach(port => {
        const publishedPort = getPublishedPort(port);
        if (Number.isInteger(publishedPort)) usedPorts.add(publishedPort);
      });
    }

    const networks = service.networks || {};
    if (!Array.isArray(networks)) {
      Object.values(networks).forEach(netConfig => {
        if (netConfig && netConfig.ipv4_address) {
          const suffix = getIpSuffixFromAddress(netConfig.ipv4_address);
          if (suffix !== null) usedIpSuffixes.add(suffix);
        }
      });
    }
  }

  return { usedPorts, usedIpSuffixes };
}

function findAvailableIpSuffix(usedIpSuffixes, preferredSuffix = null) {
  if (preferredSuffix && preferredSuffix >= 2 && preferredSuffix <= 254 && !usedIpSuffixes.has(preferredSuffix)) {
    return preferredSuffix;
  }
  for (let suffix = 100; suffix <= 254; suffix += 1) {
    if (!usedIpSuffixes.has(suffix)) return suffix;
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    if (!usedIpSuffixes.has(suffix)) return suffix;
  }
  return '';
}

function findAvailablePublishedPort(usedPorts, preferredPort = null, fallbackPort = null) {
  const candidates = [preferredPort, fallbackPort]
    .map(port => parseInt(port))
    .filter(port => Number.isInteger(port) && port >= 100 && port <= 1000);

  for (const port of candidates) {
    if (!usedPorts.has(port)) return port;
  }

  for (let port = 100; port <= 1000; port += 1) {
    if (!usedPorts.has(port)) return port;
  }
  return '';
}

function getServiceSectionComment(index, name, ipSuffix = '') {
  const suffixLabel = ipSuffix ? ` (${ipSuffix})` : '';
  return `===================================================================================\n${index}. ${name}${suffixLabel}\n===================================================================================`;
}

function addServiceSectionComment(yamlText, name, comment) {
  const commentLines = comment.split('\n').map(line => `  # ${line}`).join('\n');
  const serviceKeyPattern = new RegExp(`(^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\n)`, 'm');
  return yamlText.replace(serviceKeyPattern, `\n${commentLines}\n$1`);
}

function normalizeBuild(build) {
  if (!build) return {};
  if (typeof build === 'string') return { context: build };
  if (typeof build === 'object') {
    return {
      context: build.context || '',
      dockerfile: build.dockerfile || ''
    };
  }
  return {};
}

function parsePastedCompose(composeText, existingServices = {}) {
  const parsed = YAML.parse(composeText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('未解析到有效的 YAML 对象。');
  }

  const services = parsed.services && typeof parsed.services === 'object'
    ? parsed.services
    : parsed.image || parsed.build || parsed.container_name
      ? { [parsed.container_name || 'service']: parsed }
      : null;

  if (!services || Object.keys(services).length === 0) {
    throw new Error('未找到 services 配置。');
  }

  const [serviceKey, service] = Object.entries(services)[0];
  if (!service || typeof service !== 'object') {
    throw new Error(`服务 "${serviceKey}" 配置无效。`);
  }

  const ports = Array.isArray(service.ports)
    ? service.ports.map(normalizeComposePort).filter(port => port.published || port.target)
    : [];
  const firstPort = ports[0] || {};
  const { usedPorts, usedIpSuffixes } = collectComposeUsage(existingServices);

  let networkMode = service.network_mode === 'host' ? 'host' : 'd_home';
  let ipSuffix = '';
  const networks = service.networks || {};
  const dHomeNetwork = Array.isArray(networks)
    ? null
    : networks.D_Home || networks.d_home || null;
  if (dHomeNetwork && dHomeNetwork.ipv4_address) {
    ipSuffix = getIpSuffixFromAddress(dHomeNetwork.ipv4_address) || '';
  }

  if (networkMode !== 'host') {
    ipSuffix = findAvailableIpSuffix(usedIpSuffixes, parseInt(ipSuffix));
  }

  const publishedPort = networkMode === 'host'
    ? ''
    : findAvailablePublishedPort(usedPorts, firstPort.published, firstPort.target);

  const build = normalizeBuild(service.build);

  return {
    serviceCount: Object.keys(services).length,
    selectedService: serviceKey,
    name: serviceKey,
    containerName: service.container_name || '',
    deploySource: service.build ? 'build' : 'image',
    image: service.image || '',
    buildContext: build.context || '',
    buildDockerfile: build.dockerfile || '',
    networkMode,
    publishedPort,
    targetPort: firstPort.target || '',
    ipSuffix,
    environment: normalizeEnvironment(service.environment),
    volumes: normalizeVolumes(service.volumes),
    unsupported: {
      extraPorts: ports.length > 1 ? ports.slice(1) : [],
      containerNameDiffers: !!service.container_name && service.container_name !== serviceKey,
      publishedPortChanged: !!firstPort.published && publishedPort !== firstPort.published,
      ipSuffixChanged: !!dHomeNetwork?.ipv4_address && ipSuffix !== getIpSuffixFromAddress(dHomeNetwork.ipv4_address)
    },
    // 方案 C：保留原始 service 对象（用于透传面板不管理的字段）
    __rawService: service
  };
}

// Initialize Mock State for services parsed from compose.yml
function initializeMockState(services) {
  services.forEach(service => {
    if (!mockState[service.name]) {
      mockState[service.name] = {
        state: service.name === 'postgres' || service.name === 'cloudflare' ? 'running' : 'exited',
        status: service.name === 'postgres' || service.name === 'cloudflare' ? 'Up 2 hours' : 'Exited (0) 5 minutes ago',
        health: service.name === 'postgres' ? 'healthy' : ''
      };
    }
  });
}

// Parse compose.yml to extract services list
function parseComposeServices() {
  try {
    if (!fs.existsSync(COMPOSE_FILE_PATH)) {
      throw new Error('compose.yml not found');
    }
    // Aggregate across include files (or the single legacy services block),
    // with anchors already merge-resolved.
    const serviceEntries = readAllServiceEntries();
    if (serviceEntries.length === 0) {
      return [];
    }

    const envs = getEnvVariables();
    const subnetPrefix = envs.SUBNET_PREFIX || '172.18.0';

    return serviceEntries.map(([name, service]) => {
      // Find IP and Network Mode
      let ip = 'Dynamic';
      let ipSuffix = '';
      if (service.network_mode === 'host') {
        ip = '主机网络 (Host Mode)';
      } else if (service.networks && service.networks.D_Home && service.networks.D_Home.ipv4_address) {
        let rawIp = service.networks.D_Home.ipv4_address;
        // Resolve environment variable
        rawIp = rawIp.replace('${SUBNET_PREFIX}', subnetPrefix);
        rawIp = rawIp.replace('$SUBNET_PREFIX', subnetPrefix);
        ip = rawIp;

        const parts = service.networks.D_Home.ipv4_address.split('.');
        ipSuffix = parts[parts.length - 1].replace(/\}?$/, '').trim();
      }

      // Find Build Context and Dockerfile
      let buildContext = '';
      let buildDockerfile = '';
      let deploySource = 'image';
      if (service.build) {
        deploySource = 'build';
        if (typeof service.build === 'object') {
          buildContext = service.build.context || '';
          buildDockerfile = service.build.dockerfile || '';
        } else {
          buildContext = service.build;
        }
      }

      // Find Ports
      let ports = [];
      if (service.ports) {
        service.ports.forEach(p => {
          if (typeof p === 'object') {
            ports.push({
              target: p.target,
              published: p.published
            });
          } else if (typeof p === 'string') {
            // standard format e.g. "814:8086" or "100.101.102.100:814:8086"
            const parts = p.split(':');
            const target = parts[parts.length - 1];
            const published = parts[parts.length - 2];
            ports.push({
              target: parseInt(target),
              published: parseInt(published)
            });
          }
        });
      }

      return {
        name,
        container_name: service.container_name || name,
        image: service.image || '',
        buildContext,
        buildDockerfile,
        deploySource,
        ipSuffix,
        ip,
        ports,
        // Merge env_file contents (base) with inline environment (override) so
        // the edit form shows every variable regardless of where it is stored.
        // env_file is resolved relative to the service's own directory.
        environment: { ...readEnvFilesForService(service, service.__baseDir), ...normalizeEnvironment(service.environment) },
        volumes: normalizeVolumes(service.volumes),
        networkMode: service.network_mode === 'host' ? 'host' : 'd_home'
      };
    });
  } catch (error) {
    console.error('Error parsing compose.yml:', error);
    return [];
  }
}

// Query running Docker statuses
async function getDockerStatuses() {
  if (isMockMode) {
    return mockState;
  }
  
  try {
    // Try to run docker compose ps in json format
    const output = await runCommand('docker compose ps --format json');
    const lines = output.trim().split('\n').filter(Boolean);
    const statuses = {};
    
    lines.forEach(line => {
      try {
        const item = JSON.parse(line);
        // Note: in older versions, docker compose ps returns slightly different schemas
        const serviceName = item.Service || item.Name;
        statuses[serviceName] = {
          state: item.State || (item.Status && item.Status.toLowerCase().includes('up') ? 'running' : 'exited'),
          status: item.Status || '',
          health: item.Health || ''
        };
      } catch (e) {
        // Fallback or skip
      }
    });
    
    return statuses;
  } catch (err) {
    console.warn('Docker Compose ps failed. Falling back to CLI parsing or mock state.', err.message);
    
    // Fallback parser for standard stdout formatting if format json fails
    try {
      const output = await runCommand('docker compose ps');
      const lines = output.trim().split('\n');
      const statuses = {};
      
      // Typical columns: NAME | IMAGE | COMMAND | SERVICE | CREATED | STATUS | PORTS
      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const parts = line.split(/\s{2,}/); // split by multiple spaces
        if (parts.length >= 4) {
          const serviceName = parts[3]; // SERVICE column is 4th
          const statusStr = parts[5] || ''; // STATUS is 6th
          const isUp = statusStr.toLowerCase().includes('up');
          statuses[serviceName] = {
            state: isUp ? 'running' : 'exited',
            status: statusStr,
            health: statusStr.includes('healthy') ? 'healthy' : (statusStr.includes('unhealthy') ? 'unhealthy' : '')
          };
        }
      }
      return statuses;
    } catch (err2) {
      return {};
    }
  }
}

// API Routes

// 1. Get system & docker status
app.post('/api/compose/parse-service', (req, res) => {
  try {
    const { compose } = req.body;
    if (!compose || typeof compose !== 'string') {
      return res.status(400).json({ error: '请粘贴有效的 compose.yml 内容。' });
    }

    const existingServices = readAllServicesMap();
    const parsed = parsePastedCompose(compose, existingServices);
    res.json(parsed);
  } catch (error) {
    res.status(400).json({ error: `解析 compose 配置失败: ${error.message}` });
  }
});

app.get('/api/status', async (req, res) => {
  const envs = getEnvVariables();
  let baseServiceReady = false;
  let baseServiceError = '';
  try {
    if (fs.existsSync(COMPOSE_FILE_PATH)) {
      baseServiceError = getBaseServiceValidationError(readAllServicesMap());
      baseServiceReady = !baseServiceError;
    } else {
      baseServiceError = 'compose.yml file not found.';
    }
  } catch (error) {
    baseServiceError = error.message;
  }
  res.json({
    mockMode: isMockMode,
    baseServiceReady,
    baseServiceError,
    baseServiceName: BASE_SERVICE_NAME,
    workDir: WORK_DIR,
    envs: {
      TS_HOST_IP: envs.TS_HOST_IP || '100.101.102.100',
      SUBNET_PREFIX: envs.SUBNET_PREFIX || '172.18.0'
    },
    dockerInstalled: !isMockMode,
    platform: process.platform,
    nodeVersion: process.version
  });
});

// 2. Get list of services & their status
app.get('/api/services', async (req, res) => {
  try {
    const services = parseComposeServices();
    
    if (isMockMode) {
      initializeMockState(services);
    }
    
    const statuses = await getDockerStatuses();
    
    const enrichedServices = services.map(service => {
      const live = statuses[service.name] || {};
      return {
        ...service,
        status: live.state || 'exited',
        statusText: live.status || 'Stopped',
        health: live.health || ''
      };
    });
    
    res.json(enrichedServices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Start a service
app.post('/api/services/:name/start', async (req, res) => {
  const { name } = req.params;
  console.log(`Starting service: ${name}`);
  if (!serviceMountsReadyOrRespond(name, res)) return;
  if (isMockMode) {
    mockState[name] = { state: 'running', status: 'Up 1 second', health: 'healthy' };
    return res.json({ success: true, message: `Mock started service ${name}` });
  }

  try {
    const output = await runCommand(`docker compose up -d ${name}`);
    res.json({ success: true, output });
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

// 4. Stop a service
app.post('/api/services/:name/stop', async (req, res) => {
  const { name } = req.params;
  console.log(`Stopping service: ${name}`);
  if (name === BASE_SERVICE_NAME && !isMockMode) return baseServiceSelfOpGuard(res, '停止');
  if (isMockMode) {
    mockState[name] = { state: 'exited', status: 'Exited (0) Just now', health: '' };
    return res.json({ success: true, message: `Mock stopped service ${name}` });
  }

  try {
    const output = await runCommand(`docker compose stop ${name}`);
    res.json({ success: true, output });
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

// 5. Restart a service
app.post('/api/services/:name/restart', async (req, res) => {
  const { name } = req.params;
  console.log(`Restarting service: ${name}`);
  if (name === BASE_SERVICE_NAME && !isMockMode) return baseServiceSelfOpGuard(res, '重启');
  if (!serviceMountsReadyOrRespond(name, res)) return;
  if (isMockMode) {
    mockState[name] = { state: 'running', status: 'Up 1 second', health: 'healthy' };
    return res.json({ success: true, message: `Mock restarted service ${name}` });
  }

  try {
    const output = await runCommand(`docker compose restart ${name}`);
    res.json({ success: true, output });
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

// 6. Recreate a service (with Rebuild option)
app.post('/api/services/:name/recreate', async (req, res) => {
  const { name } = req.params;
  console.log(`Recreating and building service: ${name}`);
  if (name === BASE_SERVICE_NAME && !isMockMode) return baseServiceSelfOpGuard(res, '重建');
  if (!serviceMountsReadyOrRespond(name, res)) return;
  if (isMockMode) {
    mockState[name] = { state: 'running', status: 'Up 1 second (Rebuilt & Recreated)', health: 'healthy' };
    return res.json({ success: true, message: `Mock rebuilt and recreated service ${name}` });
  }

  try {
    const output = await runCommand(`docker compose up -d --force-recreate --build ${name}`);
    res.json({ success: true, output });
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

// 7. Pull & Update service
app.post('/api/services/:name/pull', async (req, res) => {
  const { name } = req.params;
  console.log(`Pulling image and starting service: ${name}`);
  if (name === BASE_SERVICE_NAME && !isMockMode) return baseServiceSelfOpGuard(res, '更新');
  if (!serviceMountsReadyOrRespond(name, res)) return;
  if (isMockMode) {
    return res.json({ success: true, message: `Mock pulled image for ${name}` });
  }

  try {
    const outputPull = await runCommand(`docker compose pull ${name}`);
    const outputUp = await runCommand(`docker compose up -d ${name}`);
    res.json({ success: true, output: `${outputPull}\n${outputUp}` });
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

// 7b. One-click background self-update (panel updates itself via a helper container)
app.post('/api/services/:name/self-update', async (req, res) => {
  const { name } = req.params;
  if (name !== BASE_SERVICE_NAME) {
    return res.status(400).json({ error: '该接口仅用于更新管理面板自身 (composemgt)。' });
  }
  console.log('Launching background self-update for the panel...');
  if (isMockMode) {
    return res.json({ success: true, background: true, message: '[演示模式] 已模拟后台自更新（不会真的重建）。' });
  }
  try {
    const { helperId, logPath } = await launchSelfUpdate();
    res.json({
      success: true,
      background: true,
      message: `面板正在后台更新（辅助容器 ${helperId.slice(0, 12)}）。约 20-40 秒后自动恢复，请稍候刷新页面。\n更新日志： ${logPath}`
    });
  } catch (error) {
    res.status(500).json({ error: `启动后台自更新失败：${error.toString()}` });
  }
});

// 8. Git Pull + Build + Recreate for local build services
// Find the Git repository root by walking up from a starting directory.
// The build context is often a subdirectory of the repo (e.g. the context is
// ./composemgt/manager while .git lives at ./composemgt/.git), so we search
// ancestors until a .git entry is found or we reach the filesystem root.
function findGitRoot(startPath) {
  let dir = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

app.post('/api/services/:name/build-update', async (req, res) => {
  const { name } = req.params;
  console.log(`Git pull and rebuild service: ${name}`);

  if (name === BASE_SERVICE_NAME && !isMockMode) return baseServiceSelfOpGuard(res, '更新');
  if (!serviceMountsReadyOrRespond(name, res)) return;

  if (isMockMode) {
    return res.json({
      success: true,
      output: `[演示模式] 已模拟执行 git pull + docker build + recreate for ${name}`
    });
  }

  try {
    // Look up the build context from compose.yml (server-side, never trust client input)
    const services = parseComposeServices();
    const service = services.find(s => s.name === name);

    if (!service || service.deploySource !== 'build' || !service.buildContext) {
      return res.status(400).json({
        error: `服务 "${name}" 不是本地构建类型，或未配置构建上下文路径 (build.context)。`
      });
    }

    // Resolve build context path relative to the compose working directory
    const contextPath = path.resolve(WORK_DIR, service.buildContext);

    if (!fs.existsSync(contextPath)) {
      return res.status(400).json({
        error: `构建上下文路径不存在: ${contextPath}`
      });
    }

    // Find the Git repository root by walking up from the build context.
    const gitRoot = findGitRoot(contextPath);
    if (!gitRoot) {
      return res.status(400).json({
        error: `构建上下文目录 "${contextPath}" 及其上级目录都不是 Git 仓库（未找到 .git 目录），无法执行 git pull。请确认该项目是通过 git clone 获得的。`
      });
    }

    // Step 1: Run git pull in the Git repository root
    const gitOutput = await new Promise((resolve, reject) => {
      exec('git pull', { cwd: gitRoot, timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          reject(`Git Pull 失败: ${error.message}\n${stderr}`);
        } else {
          resolve((stdout + stderr).trim());
        }
      });
    });

    // Step 2: Rebuild and recreate the container
    const buildOutput = await runCommand(`docker compose up -d --force-recreate --build ${name}`);

    res.json({
      success: true,
      output: `=== Git Pull (${gitRoot}) ===\n${gitOutput}\n\n=== Docker Build & Recreate ===\n${buildOutput}`
    });
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

// 9. Get service logs (Static snapshot)
app.get('/api/services/:name/logs', async (req, res) => {
  const { name } = req.params;
  if (isMockMode) {
    const time = new Date().toISOString();
    const mockLogs = [
      `[${time}] INFO  [main] Starting mock server container for ${name}`,
      `[${time}] INFO  [main] Database connection pool initialized`,
      `[${time}] DEBUG [main] Loading local settings and profiles`,
      `[${time}] INFO  [http] Server listening on interface 0.0.0.0`,
      `[${time}] INFO  [status] Service "${name}" is healthy and running fine.`,
      `[${time}] WARN  [health] Heartbeat delay detected, but restored instantly`
    ].join('\n');
    return res.json({ logs: mockLogs });
  }

  try {
    const output = await runCommand(`docker compose logs --tail=100 ${name}`);
    res.json({ logs: output });
  } catch (error) {
    res.status(500).json({ error: error.toString() });
  }
});

// 8b. Stream service logs in real-time (Server-Sent Events)
app.get('/api/services/:name/logs/stream', (req, res) => {
  const { name } = req.params;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (isMockMode) {
    const time = new Date().toISOString();
    res.write(`data: [${time}] INFO  [main] Connected to real-time log stream for "${name}" (Mock Mode)\n\n`);
    res.write(`data: [${time}] INFO  [main] Streaming logs... (Press Close to stop)\n\n`);

    let count = 0;
    const sendMockLog = () => {
      const logTime = new Date().toISOString();
      const logs = [
        `[${logTime}] INFO  [worker-mock-${name}] Processed job batch #${Math.floor(Math.random() * 1000)} successfully.`,
        `[${logTime}] DEBUG [connection] Heartbeat check OK for host.docker.internal`,
        `[${logTime}] WARN  [network] Connection latency spike: 42ms (recovered)`,
        `[${logTime}] INFO  [api] GET /health - 200 OK from client-check`,
        `[${logTime}] DEBUG [gc] Garbage collection run completed (freed 4.2MB)`
      ];
      const randomLog = logs[Math.floor(Math.random() * logs.length)];
      res.write(`data: ${randomLog}\n\n`);
      count++;
    };

    const intervalId = setInterval(sendMockLog, 1500);
    req.on('close', () => {
      clearInterval(intervalId);
    });
    return;
  }

  // Real Mode: Spawn "docker compose logs -f --tail=100 name"
  console.log(`Streaming live logs for: ${name}`);
  const logProcess = spawn('docker', ['compose', 'logs', '-f', '--tail=100', name], {
    cwd: WORK_DIR
  });

  const sendLines = (text) => {
    const lines = text.split('\n');
    lines.forEach(line => {
      const cleanLine = line.replace(/\r/g, '');
      res.write(`data: ${cleanLine}\n\n`);
    });
  };

  logProcess.stdout.on('data', (data) => {
    sendLines(data.toString());
  });

  logProcess.stderr.on('data', (data) => {
    sendLines(data.toString());
  });

  logProcess.on('error', (err) => {
    res.write(`data: Error launching log stream: ${err.message}\n\n`);
  });

  req.on('close', () => {
    console.log(`Closing log stream for: ${name}`);
    logProcess.kill();
  });
});

// 9. Add or Edit service in compose.yml
app.post('/api/services', async (req, res) => {
  try {
    const { name, deploySource, image, buildContext, buildDockerfile, publishedPort, targetPort, ipSuffix, environment, volumes, isEdit, networkMode } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: '服务标识 (ID) 是必填项。' });
    }
    if (name === BASE_SERVICE_NAME) {
      return res.status(400).json({ error: `"${BASE_SERVICE_NAME}" 是系统保留的基础服务，不能通过普通容器表单新增或编辑。` });
    }
    if (deploySource === 'build') {
      if (!buildContext) {
        return res.status(400).json({ error: '构建上下文路径 (Context) 是必填项。' });
      }
    } else {
      if (!image) {
        return res.status(400).json({ error: 'Docker 镜像地址是必填项。' });
      }
    }

    if (!fs.existsSync(COMPOSE_FILE_PATH)) {
      return res.status(500).json({ error: 'compose.yml file not found.' });
    }

    const mode = getComposeMode();
    // Aggregate view of every service across the stack (include files or the
    // legacy single block), used for duplicate / port / IP conflict checks.
    const existingServices = readAllServicesMap();
    if (existingServices[name] && !isEdit) {
      return res.status(400).json({ error: `服务 ID "${name}" 已经存在。` });
    }

    try {
      await assertBaseServiceDeployable(existingServices);
    } catch (baseError) {
      return res.status(400).json({ error: baseError.message });
    }

    const isHostNet = (networkMode === 'host');

    // Check port conflict
    if (publishedPort && !isHostNet) {
      const pubPortInt = parseInt(publishedPort);
      for (const [srvName, srvConfig] of Object.entries(existingServices)) {
        if (srvName === name) continue;
        if (Array.isArray(srvConfig.ports)) {
          for (const p of srvConfig.ports) {
            let srvPubPort = null;
            if (typeof p === 'object' && p !== null) {
              srvPubPort = p.published;
            } else if (typeof p === 'string') {
              const parts = p.split(':');
              if (parts.length >= 2) {
                // Format could be "hostIp:hostPort:containerPort" or "hostPort:containerPort"
                srvPubPort = parseInt(parts[parts.length - 2]);
              } else if (parts.length === 1) {
                srvPubPort = parseInt(parts[0]);
              }
            }
            if (srvPubPort !== null && parseInt(srvPubPort) === pubPortInt) {
              return res.status(400).json({ error: `端口 ${pubPortInt} 已被现有服务 "${srvName}" 占用，请更换端口。` });
            }
          }
        }
      }
    }

    // Check IP suffix conflict
    if (ipSuffix && !isHostNet) {
      const ipSuffixStr = ipSuffix.toString().trim();
      for (const [srvName, srvConfig] of Object.entries(existingServices)) {
        if (srvName === name) continue;
        const networks = srvConfig.networks || {};
        for (const netConfig of Object.values(networks)) {
          if (netConfig && netConfig.ipv4_address) {
            const addr = netConfig.ipv4_address.toString();
            const parts = addr.split('.');
            const lastPart = parts[parts.length - 1].replace(/\}?$/, '').trim(); // Remove optional } from ${SUBNET_PREFIX}.118
            if (lastPart === ipSuffixStr) {
              return res.status(400).json({ error: `子网 IP 尾数 .${ipSuffixStr} 已被现有服务 "${srvName}" 占用，请更换 IP。` });
            }
          }
        }
      }
    }

    // Build the new service structure
    const newService = {
      container_name: name
    };

    if (deploySource === 'build') {
      newService.build = {
        context: buildContext
      };
      if (buildDockerfile && buildDockerfile.trim()) {
        newService.build.dockerfile = buildDockerfile.trim();
      }
    } else {
      newService.image = image;
    }

    // Add service base defaults
    // Since we use YAML anchors, we need to create the exact reference in YAML
    // But programmatically, YAML document API will output it cleanly.
    // Let's set the base anchor reference if possible, or build it manually:
    // We can define standard restart, logging, network setup
    
    // Add network mode configuration
    if (isHostNet) {
      newService.network_mode = 'host';
    } else {
      // Add networks & IP
      if (ipSuffix) {
        newService.networks = {
          D_Home: {
            ipv4_address: `\${SUBNET_PREFIX}.${ipSuffix}`
          }
        };
      }

      // Add ports
      if (publishedPort && targetPort) {
        newService.ports = [
          {
            target: parseInt(targetPort),
            published: parseInt(publishedPort),
            host_ip: '${TS_HOST_IP}',
            protocol: 'tcp'
          }
        ];
      }
    }

    // Physical directory holding this container's data/env (same in both modes).
    const serviceDir = path.join(WORK_DIR, name);
    // Path string used for relative references inside the compose file:
    //  - include: relative to the container's own dir  -> ./.env
    //  - legacy:  under ./<name>/ relative to root      -> ./<name>/.env
    const envFileRef = mode === 'include' ? './.env' : `./${name}/.env`;

    // Add env vars following the per-container convention:
    //  - literal values -> written to <name>/.env and referenced via env_file
    //  - values with $  -> kept inline (env_file is literal; ${VAR} would not
    //    expand, so interpolated values must stay in the environment: block)
    // In include mode the container's .env also carries the global interpolation
    // vars (SUBNET_PREFIX/TS_HOST_IP/TZ) so the container runs standalone.
    const fileVars = {};
    const inlineVars = {};
    if (environment && Object.keys(environment).length > 0) {
      for (const [key, rawVal] of Object.entries(environment)) {
        const val = rawVal === null || rawVal === undefined ? '' : String(rawVal);
        if (val.includes('$')) {
          inlineVars[key] = val;
        } else {
          fileVars[key] = val;
        }
      }
    }

    const wantEnvFile = mode === 'include'
      ? true                                   // always: needed for standalone interpolation
      : Object.keys(fileVars).length > 0;      // legacy: only when there are literal vars

    if (wantEnvFile) {
      if (!fs.existsSync(serviceDir)) {
        fs.mkdirSync(serviceDir, { recursive: true, mode: 0o755 });
      }
      // Preserve interpolation-only values already present in the service .env
      // (e.g. GROK2API_CONFIG). They may not appear in service.environment but
      // Docker Compose still uses them while resolving image/volume expressions.
      let existingLocalVars = {};
      const localEnvPath = path.join(serviceDir, '.env');
      if (fs.existsSync(localEnvPath)) {
        try {
          existingLocalVars = dotenv.parse(fs.readFileSync(localEnvPath, 'utf8'));
        } catch (error) {
          console.warn(`⚠️  Could not preserve ${name}/.env: ${error.message}`);
        }
      }

      // include mode: global defaults, existing interpolation vars, then form
      // values (the explicit form input wins on key clashes).
      const merged = mode === 'include'
        ? { ...getGlobalInterpolationVars(), ...existingLocalVars, ...fileVars }
        : { ...existingLocalVars, ...fileVars };
      const envContent = Object.entries(merged)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n';
      fs.writeFileSync(path.join(serviceDir, '.env'), envContent, { encoding: 'utf8', mode: 0o644 });
      console.log(`📝 Wrote container env file: ${name}/.env (${Object.keys(merged).length} vars)`);
      newService.env_file = [envFileRef];
    }

    if (Object.keys(inlineVars).length > 0) {
      newService.environment = inlineVars;
    }

    // Add volumes. On create, relocate relative host paths to this container's
    // convention (include: ./data ; legacy: ./<name>/data). On edit we keep the
    // stored paths as-is, to avoid repointing a container to a fresh empty dir.
    if (volumes && volumes.length > 0) {
      const finalVolumes = isEdit
        ? volumes.slice()
        : volumes.map(v => conventionVolumeEntry(v, name, mode));
      newService.volumes = finalVolumes;

      // Resolve each relative host path to its physical location and pre-create
      // it. Physical base differs by mode but the resulting path is the same
      // ($STACK_DIR/<name>/...).
      const physBase = mode === 'include' ? serviceDir : WORK_DIR;
      const mountError = getReadOnlyFileMountError(name, finalVolumes, physBase);
      if (mountError) {
        const error = new Error(mountError);
        error.statusCode = 400;
        throw error;
      }

      for (const volumeEntry of finalVolumes) {
        if (typeof volumeEntry !== 'string') continue;
        const parsedVolume = splitVolumeEntry(volumeEntry);
        if (!parsedVolume.hasTarget) continue;

        const effectiveSource = effectiveVolumeSource(
          parsedVolume.source,
          getVolumeInterpolationEnv(physBase)
        );
        const fullPath = resolveHostPathForCreation(parsedVolume.source, physBase);
        if (!effectiveSource || !fullPath) continue; // named volume or unresolved ${VAR}

        const isRelativeSource = effectiveSource === '.'
          || effectiveSource.startsWith('./')
          || effectiveSource.startsWith('../');
        const isFileMount = !effectiveSource.endsWith('/') && !!path.extname(fullPath);
        const isReadOnly = isReadOnlyVolumeTarget(parsedVolume.targetAndMode);

        if (isFileMount && isReadOnly) {
          continue;
        }

        // Relative writable paths belong to this stack and may be created.
        // Absolute paths are external resources and are never created here.
        if (isRelativeSource) {
          const result = ensureHostPathExists(fullPath, effectiveSource);
          if (result.created) {
            console.log(`${result.kind === 'file' ? '📄' : '📁'} Created mount ${result.kind}: ${path.relative(WORK_DIR, fullPath)}`);
          }
        }
      }
    }

    // Add restart and logging options
    newService.restart = 'unless-stopped';
    newService.logging = {
      driver: 'json-file',
      options: {
        'max-size': '10m',
        'max-file': '3'
      }
    };

    // ========== 方案 A：编辑时保留面板不管理的字段 ==========
    // 面板管理的字段（会被上面 newService 覆盖）：
    //   container_name, image, build, network_mode, networks, ports,
    //   env_file, environment, volumes, restart, logging
    // 面板不管理、应保留的字段（Docker 运行时选项）：
    //   init, stop_grace_period, stop_signal, security_opt, cap_add, cap_drop,
    //   privileged, devices, sysctls, ulimits, healthcheck, depends_on, labels, etc.
    if (isEdit && mode === 'include') {
      const existingPath = serviceComposePath(name);
      if (fs.existsSync(existingPath)) {
        try {
          const existingDoc = YAML.parse(fs.readFileSync(existingPath, 'utf8'), { merge: true });
          const existingSvc = existingDoc?.services?.[name];
          if (existingSvc && typeof existingSvc === 'object') {
            const managedKeys = new Set([
              'container_name', 'image', 'build', 'network_mode', 'networks', 'ports',
              'env_file', 'environment', 'volumes', 'restart', 'logging'
            ]);
            for (const [key, value] of Object.entries(existingSvc)) {
              if (!managedKeys.has(key) && !(key in newService)) {
                newService[key] = value;
                console.log(`♻️  保留用户自定义字段: ${name}.${key}`);
              }
            }
          }
        } catch (e) {
          console.warn(`⚠️  无法读取现有 compose 文件以保留字段: ${e.message}`);
        }
      }
    }
    // ========== 方案 A 结束 ==========

    // ========== 方案 C：粘贴创建时保留原始 compose 的所有字段 ==========
    // 用户粘贴完整 compose（带 init/security_opt 等高级字段）→ 面板提取填表
    // → 提交时把原 YAML 里面板不管理的字段也一并透传到 newService
    if (!isEdit && req.body.compose) {
      try {
        const parsed = parsePastedCompose(req.body.compose, existingServices);
        if (parsed.__rawService && typeof parsed.__rawService === 'object') {
          const managedKeys = new Set([
            'container_name', 'image', 'build', 'network_mode', 'networks', 'ports',
            'env_file', 'environment', 'volumes', 'restart', 'logging'
          ]);
          for (const [key, value] of Object.entries(parsed.__rawService)) {
            if (!managedKeys.has(key) && !(key in newService)) {
              newService[key] = value;
              console.log(`📋 透传粘贴的字段: ${name}.${key}`);
            }
          }
        }
      } catch (e) {
        console.warn(`⚠️  无法解析粘贴的 compose 以透传字段: ${e.message}`);
      }
    }
    // ========== 方案 C 结束 ==========

    if (mode === 'include') {
      // Write the container's self-contained compose file
      if (!fs.existsSync(serviceDir)) {
        fs.mkdirSync(serviceDir, { recursive: true, mode: 0o755 });
      }
      const containerDoc = {
        services: { [name]: newService },
        networks: { D_Home: { external: true } }
      };
      // Declare any named volumes so the self-contained file is valid on its own.
      const namedVols = extractNamedVolumes(newService.volumes || []);
      if (namedVols.length > 0) {
        containerDoc.volumes = {};
        for (const nv of namedVols) containerDoc.volumes[nv] = null;
      }
      const header = `# ${name} —— 由 ComposeMgt 管理\n`
        + `# 可单独运行： cd ${name} && docker compose up -d\n`;
      fs.writeFileSync(serviceComposePath(name), header + YAML.stringify(containerDoc), 'utf8');

      // Register in the main include list (append; keep composemgt first)
      if (!isEdit) {
        const mainDoc = YAML.parseDocument(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'));
        const entryPath = `${name}/compose.yml`;
        const incNode = mainDoc.get('include');
        const existingPaths = (incNode && incNode.items ? incNode.items : [])
          .map(it => String(it.value ?? it));
        const already = existingPaths.some(p => p === entryPath || p === './' + entryPath);
        if (!already) {
          mainDoc.addIn(['include'], entryPath);
          fs.writeFileSync(COMPOSE_FILE_PATH, mainDoc.toString(), 'utf8');
        }
      }
    } else {
      // Legacy single-file mode: insert/replace the service in compose.yml
      const doc = YAML.parseDocument(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'));
      doc.setIn(['services', name], newService);
      // Declare any named volumes at the top level, else compose rejects the file.
      for (const nv of extractNamedVolumes(newService.volumes || [])) {
        if (!doc.hasIn(['volumes', nv])) doc.setIn(['volumes', nv], null);
      }
      let nextComposeContent = doc.toString();
      if (!isEdit) {
        nextComposeContent = addServiceSectionComment(
          nextComposeContent,
          name,
          getServiceSectionComment(Object.keys(existingServices).length + 1, name, isHostNet ? '' : ipSuffix)
        );
      }
      fs.writeFileSync(COMPOSE_FILE_PATH, nextComposeContent, 'utf8');
    }

    if (isMockMode) {
      mockState[name] = { state: 'exited', status: 'Created', health: '' };
    }

    res.json({ success: true, message: `Successfully saved service "${name}"` });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// 10. Delete a service from compose.yml
app.delete('/api/services/:name', async (req, res) => {
  try {
    const { name } = req.params;
    if (name === BASE_SERVICE_NAME) {
      return res.status(400).json({ error: `"${BASE_SERVICE_NAME}" 是系统基础服务，不能删除。` });
    }
    
    if (!fs.existsSync(COMPOSE_FILE_PATH)) {
      return res.status(500).json({ error: 'compose.yml file not found.' });
    }

    const mode = getComposeMode();
    const allServicesMap = readAllServicesMap();
    const serviceObj = allServicesMap[name];
    if (!serviceObj) {
      return res.status(404).json({ error: `Service "${name}" not found.` });
    }

    // Stop container first if in real mode
    if (!isMockMode) {
      try {
        await runCommand(`docker compose down ${name}`);
      } catch (e) {
        console.warn(`Failed to stop container before deletion: ${e.message}`);
      }
    }

    if (mode === 'include') {
      // Remove the include entry from the main file
      const mainDoc = YAML.parseDocument(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'));
      const incNode = mainDoc.get('include');
      if (incNode && Array.isArray(incNode.items)) {
        const entryPath = `${name}/compose.yml`;
        const idx = incNode.items.findIndex(it => {
          const v = String(it.value ?? it);
          return v === entryPath || v === './' + entryPath;
        });
        if (idx !== -1) {
          incNode.delete(idx);
          fs.writeFileSync(COMPOSE_FILE_PATH, mainDoc.toString(), 'utf8');
        }
      }
      // Remove the container's compose file. Its data dir (<name>/) is kept on
      // purpose so no data is lost; the user can delete it manually if desired.
      const cfile = serviceComposePath(name);
      if (fs.existsSync(cfile)) fs.unlinkSync(cfile);

      if (isMockMode) delete mockState[name];
      return res.json({ success: true, message: `已从编排移除 "${name}"（数据目录 ${name}/ 已保留）。` });
    }

    // ---- legacy single-file mode ----
    const doc = YAML.parseDocument(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'));
    const serviceNode = doc.getIn(['services', name]);
    if (!serviceNode) {
      return res.status(404).json({ error: `Service "${name}" not found.` });
    }

    // Clean up .env variables uniquely referenced by this service
    try {
      const serviceObjJson = serviceNode.toJSON();
      const serviceStr = JSON.stringify(serviceObjJson);
      const regex = /\$\{?([A-Z0-9_]+)\}?/g;
      const referencedVars = new Set();
      let match;
      while ((match = regex.exec(serviceStr)) !== null) {
        referencedVars.add(match[1]);
      }

      const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '') + '_';
      const envVars = getEnvVariables();
      const keysToRemove = [];

      for (const key of Object.keys(envVars)) {
        const matchesPrefix = key.toUpperCase().startsWith(prefix);
        const isReferenced = referencedVars.has(key);

        if (isReferenced || matchesPrefix) {
          // Verify if it is referenced by any OTHER service in compose.yml
          let isShared = false;
          const allServices = doc.get('services').toJSON();
          for (const [otherName, otherConfig] of Object.entries(allServices)) {
            if (otherName === name) continue;
            const otherStr = JSON.stringify(otherConfig);
            if (otherStr.includes(`\${${key}}`) || otherStr.includes(`$${key}`)) {
              isShared = true;
              break;
            }
          }
          if (!isShared) {
            keysToRemove.push(key);
          }
        }
      }

      if (keysToRemove.length > 0) {
        keysToRemove.forEach(key => delete envVars[key]);
        saveEnvVariables(envVars);
        console.log(`🧹 Cleaned up service environment variables from .env: ${keysToRemove.join(', ')}`);
      }
    } catch (envErr) {
      console.warn('Failed to clean up service environment variables:', envErr);
    }

    // Delete node
    doc.deleteIn(['services', name]);

    // Save back to disk
    fs.writeFileSync(COMPOSE_FILE_PATH, doc.toString(), 'utf8');

    if (isMockMode) {
      delete mockState[name];
    }

    res.json({ success: true, message: `Service "${name}" and its associated variables deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 10b. Backup one container (its <name>/ tree + all named volumes) as one .tar.gz.
//      The tree (compose.yml + .env + bind data) is read directly off the identity
//      mount; named volumes live in Docker's store, so a short-lived alpine helper
//      (socket + volume mounts) packs everything into a single gzip we then stream.
app.get('/api/services/:name/backup', async (req, res) => {
  const { name } = req.params;
  if (!VALID_SERVICE_NAME.test(name)) return res.status(400).json({ error: '非法服务名。' });
  if (name === BASE_SERVICE_NAME) return res.status(400).json({ error: 'composemgt 是管理面板自身，不支持在线备份（请在主机手动打包）。' });
  if (isMockMode) return res.status(400).json({ error: '演示模式（未检测到 Docker），无法执行备份。' });

  const mode = getComposeMode();
  const svc = readAllServicesMap()[name];
  if (!svc) return res.status(404).json({ error: `服务 "${name}" 不存在。` });

  const containerName = svc.container_name || name;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const stagingRoot = path.join(CONFIG_DIR, '.backup-tmp', `${name}-${ts}-${process.pid}`);
  const contentDir = path.join(stagingRoot, 'content');
  const outDir = path.join(stagingRoot, 'out');
  const cleanup = () => { try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

  try {
    fs.mkdirSync(path.join(contentDir, 'volumes'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    // Named volumes: prefer the live container's mounts; fall back to compose decl.
    let volNames = [];
    try {
      volNames = (await getServiceNamedVolumeMounts(containerName)).map(m => m.name);
    } catch (e) { /* container may be stopped/absent */ }
    if (volNames.length === 0) volNames = extractNamedVolumes(svc.volumes || []);
    volNames = [...new Set(volNames)].filter(v => VALID_SERVICE_NAME.test(v));

    const treeDir = path.join(WORK_DIR, name);
    const hasTree = fs.existsSync(treeDir);

    const manifest = {
      tool: 'composemgt', kind: 'container-backup', version: 1,
      name, containerName, mode, volumes: volNames, hasTree,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(contentDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Stash the service's own compose file too (helps legacy/standalone recovery).
    const cfile = serviceComposePath(name);
    if (fs.existsSync(cfile)) fs.copyFileSync(cfile, path.join(contentDir, 'compose.yml'));

    const volMountArgs = volNames.map(v => `-v ${v}:/vol/${v}:ro`).join(' ');
    const packScript = [
      'set -e',
      hasTree ? `cd /stack && tar -cf /content/tree.tar ${name}` : 'true',
      'if [ -d /vol ]; then for d in /vol/*; do [ -d "$d" ] || continue; v=$(basename "$d"); tar -cf "/content/volumes/$v.tar" -C "$d" . ; done; fi',
      'cd /content && tar -czf /out/backup.tar.gz .'
    ].join(' && ');

    const runCmd = [
      'docker run --rm',
      `-v ${WORK_DIR}:/stack:ro`,
      `-v ${contentDir}:/content`,
      `-v ${outDir}:/out`,
      volMountArgs,
      'alpine sh -c', JSON.stringify(packScript)
    ].filter(Boolean).join(' ');

    await runLong(runCmd);

    const gzPath = path.join(outDir, 'backup.tar.gz');
    if (!fs.existsSync(gzPath)) throw new Error('打包失败：未生成备份文件。');

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-backup-${ts}.tar.gz"`);
    const stream = fs.createReadStream(gzPath);
    stream.on('close', cleanup);
    stream.on('error', () => { cleanup(); if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
  } catch (error) {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: `备份失败：${error.message}` });
  }
});

// 10c. Restore a container from an uploaded .tar.gz (raw request body).
//      Recreates <name>/ from tree.tar, recreates + refills each named volume,
//      and registers the service into the include list. Does NOT auto-start.
app.post('/api/services/restore', async (req, res) => {
  if (isMockMode) return res.status(400).json({ error: '演示模式（未检测到 Docker），无法执行恢复。' });

  const stagingRoot = path.join(CONFIG_DIR, '.restore-tmp', `restore-${Date.now()}-${process.pid}`);
  const uploadPath = path.join(stagingRoot, 'backup.tar.gz');
  const cleanup = () => { try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

  try {
    fs.mkdirSync(stagingRoot, { recursive: true });

    // Stream the raw upload to disk (no multer dependency; express.json ignores
    // non-JSON content types, so the request stream is untouched here).
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(uploadPath);
      req.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      req.pipe(ws);
    });
    if (!fs.existsSync(uploadPath) || fs.statSync(uploadPath).size === 0) {
      throw new Error('未接收到上传文件。');
    }

    // Unpack the outer gzip via a helper (don't assume the panel image has tar).
    await runLong(`docker run --rm -v ${stagingRoot}:/in alpine sh -c ${JSON.stringify('mkdir -p /in/x && tar -xzf /in/backup.tar.gz -C /in/x')}`);

    const manifestPath = path.join(stagingRoot, 'x', 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('备份缺少 manifest.json，可能不是本工具导出的容器备份。');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const name = manifest.name;
    if (!name || !VALID_SERVICE_NAME.test(name)) throw new Error('备份 manifest 中的服务名非法。');
    if (name === BASE_SERVICE_NAME) throw new Error('不能把备份恢复为基础服务 composemgt。');

    const overwrite = String(req.query.overwrite || '') === '1';
    if (readAllServicesMap()[name] && !overwrite) {
      throw new Error(`服务 "${name}" 已存在。如需覆盖，请勾选「覆盖已有同名容器」后重试。`);
    }

    // 1. Restore the container's own directory tree.
    if (manifest.hasTree && fs.existsSync(path.join(stagingRoot, 'x', 'tree.tar'))) {
      await runLong(`docker run --rm -v ${WORK_DIR}:/stack -v ${stagingRoot}:/in:ro alpine sh -c ${JSON.stringify('cd /stack && tar -xf /in/x/tree.tar')}`);
    } else if (fs.existsSync(path.join(stagingRoot, 'x', 'compose.yml'))) {
      const dest = path.join(WORK_DIR, name);
      fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
      fs.copyFileSync(path.join(stagingRoot, 'x', 'compose.yml'), path.join(dest, 'compose.yml'));
    }

    // 2. Recreate and refill each named volume.
    const vols = Array.isArray(manifest.volumes) ? manifest.volumes.filter(v => VALID_SERVICE_NAME.test(v)) : [];
    for (const v of vols) {
      if (!fs.existsSync(path.join(stagingRoot, 'x', 'volumes', `${v}.tar`))) continue;
      await runLong(`docker volume create ${v}`);
      await runLong(`docker run --rm -v ${v}:/v -v ${stagingRoot}:/in:ro alpine sh -c ${JSON.stringify(`cd /v && tar -xf /in/x/volumes/${v}.tar`)}`);
    }

    // 3. Register into the include list if this is an include-layout stack.
    if (getComposeMode() === 'include') {
      const mainDoc = YAML.parseDocument(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'));
      const entryPath = `${name}/compose.yml`;
      const incNode = mainDoc.get('include');
      const paths = (incNode && incNode.items ? incNode.items : []).map(it => String(it.value ?? it));
      if (!paths.some(p => p === entryPath || p === './' + entryPath)) {
        mainDoc.addIn(['include'], entryPath);
        fs.writeFileSync(COMPOSE_FILE_PATH, mainDoc.toString(), 'utf8');
      }
    }

    res.json({
      success: true, name, volumes: vols,
      message: `已恢复容器 "${name}"（含 ${vols.length} 个命名卷）。在容器卡片点「启动」，或主机执行： docker compose up -d ${name}`
    });
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: `恢复失败：${error.message}` });
  } finally {
    cleanup();
  }
});

// 11. Get Env Variables file content grouped by service
app.get('/api/env', (req, res) => {
  try {
    const envVars = getEnvVariables();
    const rawContent = fs.existsSync(ENV_FILE_PATH) ? fs.readFileSync(ENV_FILE_PATH, 'utf8') : '';
    
    const grouping = {
      global: [],
      services: {}
    };
    
    if (fs.existsSync(COMPOSE_FILE_PATH)) {
      const composeContent = fs.readFileSync(COMPOSE_FILE_PATH, 'utf8');
      const doc = YAML.parse(composeContent);
      const services = doc.services || {};
      
      const varToServices = {};
      for (const [srvName, srvConfig] of Object.entries(services)) {
        grouping.services[srvName] = [];
        const srvStr = JSON.stringify(srvConfig);
        const regex = /\$\{?([A-Z0-9_]+)\}?/g;
        let match;
        while ((match = regex.exec(srvStr)) !== null) {
          const varName = match[1];
          if (!varToServices[varName]) {
            varToServices[varName] = new Set();
          }
          varToServices[varName].add(srvName);
        }
      }
      
      const serviceNames = Object.keys(services);
      for (const key of Object.keys(envVars)) {
        const parentServices = varToServices[key] ? Array.from(varToServices[key]) : [];
        if (parentServices.length === 1) {
          grouping.services[parentServices[0]].push(key);
        } else if (parentServices.length > 1) {
          grouping.global.push(key);
        } else {
          // Prefix matching fallback
          let matchedService = null;
          for (const srvName of serviceNames) {
            const prefix = srvName.toUpperCase().replace(/[^A-Z0-9]/g, '') + '_';
            if (key.toUpperCase().startsWith(prefix)) {
              matchedService = srvName;
              break;
            }
          }
          if (matchedService) {
            grouping.services[matchedService].push(key);
          } else {
            grouping.global.push(key);
          }
        }
      }
    } else {
      grouping.global = Object.keys(envVars);
    }
    
    res.json({ envVars, rawContent, grouping });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 12. Save Env Variables
app.post('/api/env', (req, res) => {
  try {
    const { envVars, rawContent } = req.body;
    
    if (rawContent !== undefined) {
      // Save raw text directly
      fs.writeFileSync(ENV_FILE_PATH, rawContent, 'utf8');
    } else if (envVars) {
      // Save parsed key-values
      saveEnvVariables(envVars);
    } else {
      return res.status(400).json({ error: 'Invalid data' });
    }

    res.json({ success: true, message: 'Environment configuration saved successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 13. Run custom Docker or Docker Compose commands (Web Terminal)
app.post('/api/terminal/run', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }

    const trimmedCmd = command.trim();
    
    // Security restriction: Only allow commands starting with "docker"
    if (!trimmedCmd.startsWith('docker')) {
      return res.status(403).json({
        error: '出于系统安全考虑，控制台目前仅允许执行以 "docker" 或 "docker compose" 开头的运维管理指令。'
      });
    }

    const cmdLower = trimmedCmd.toLowerCase();
    
    // 1. Logs follow check
    if (cmdLower.includes('logs') && (/\s-f(\s|$)/.test(cmdLower) || cmdLower.includes('--follow'))) {
      return res.status(403).json({
        error: '控制台暂不支持持续跟踪日志（-f 或 --follow 参数）。如果您想查看日志，请直接运行不带 -f 的命令（例如使用 "docker logs [容器名]" 或 "docker compose logs"）。'
      });
    }
    
    // 2. Interactive terminal checks
    if (/\s-(it|i|t)(\s|$)/.test(cmdLower) || cmdLower.includes('--interactive') || cmdLower.includes('--tty')) {
      return res.status(403).json({
        error: '网页控制台属于非交互式终端，无法执行包含交互式或伪终端参数（如 -it, -i, -t, --interactive, --tty）的指令。'
      });
    }
    
    // 3. Attach check
    if (/\sattach(\s|$)/.test(cmdLower)) {
      return res.status(403).json({
        error: '控制台不支持 attach 命令，因为这会导致后台进程永久阻塞。'
      });
    }

    if (isMockMode) {
      // In mock/demo mode, simulate common output profiles
      let mockOutput = '';
      if (trimmedCmd.includes('stats')) {
        mockOutput = `CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT     MEM %     NET I/O          BLOCK I/O   PIDS\n` +
                     `100a0e9bc04b   postgres   0.15%     32.4MiB / 1.952GiB    1.62%     4.2kB / 3.8kB    0B / 12kB   8\n` +
                     `200b0f9cd05c   owu        0.02%     184.2MiB / 1.952GiB   9.21%     124kB / 856kB    0B / 0B     24\n` +
                     `300c0a9de06d   cloudflare 0.10%     12.8MiB / 1.952GiB    0.64%     1.5MB / 950kB    0B / 0B     12`;
      } else if (trimmedCmd.includes('system df')) {
        mockOutput = `TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\n` +
                     `Images          12        3         4.82GB    3.21GB (66%)\n` +
                     `Containers      14        3         142.4MB   0B (0%)\n` +
                     `Local Volumes   1         1         82.1MB    0B (0%)\n` +
                     `Build Cache     32        0         1.24GB    1.24GB`;
      } else if (trimmedCmd.includes('images')) {
        mockOutput = `REPOSITORY                     TAG       IMAGE ID       CREATED        SIZE\n` +
                     `postgres                       17        a1b2c3d4e5f6   2 days ago     450MB\n` +
                     `ghcr.io/open-webui/open-webui  main      f6e5d4c3b2a1   5 hours ago    1.2GB\n` +
                     `cloudflare/cloudflared         latest    bc12de34fa56   1 week ago     85MB`;
      } else if (trimmedCmd.includes('volume ls')) {
        mockOutput = `DRIVER    VOLUME NAME\n` +
                     `local     composemgt_postgres-data\n` +
                     `local     composemgt_anylisten-data`;
      } else if (trimmedCmd.includes('network ls')) {
        mockOutput = `NETWORK ID     NAME                 DRIVER    SCOPE\n` +
                     `7f1a2b3c4d5e   bridge               bridge    local\n` +
                     `8a9b0c1d2e3f   composemgt_D_Home    bridge    local\n` +
                     `9c8d7e6f5a4b   host                 host      local\n` +
                     `0e9a8b7c6d5e   none                 null      local`;
      } else {
        mockOutput = `[演示模式 (Mock Mode)]\n已成功模拟运行: ${trimmedCmd}\n状态: 执行成功 (Exit Code 0)`;
      }
      return res.json({ stdout: mockOutput, stderr: '' });
    }

    // Real Mode execution
    const output = await runCommand(trimmedCmd);
    res.json({ stdout: output, stderr: '' });
  } catch (error) {
    res.json({ stdout: '', stderr: error.toString() });
  }
});

const CUSTOM_CMDS_PATH = path.join(CONFIG_DIR, 'custom_commands.json');
const DEFAULT_COMMANDS = [
  { name: '状态监控 (stats)', cmd: 'docker stats --no-stream' },
  { name: '磁盘占用 (df)', cmd: 'docker system df' },
  { name: '镜像列表 (images)', cmd: 'docker images' },
  { name: '数据卷列表 (volume ls)', cmd: 'docker volume ls' },
  { name: '网络列表 (network ls)', cmd: 'docker network ls' },
  { name: 'Compose 状态 (ps -a)', cmd: 'docker compose ps -a' }
];

// 14. Get custom/common commands list
app.get('/api/terminal/commands', (req, res) => {
  try {
    if (!fs.existsSync(CUSTOM_CMDS_PATH)) {
      fs.writeFileSync(CUSTOM_CMDS_PATH, JSON.stringify(DEFAULT_COMMANDS, null, 2), 'utf8');
      return res.json(DEFAULT_COMMANDS);
    }
    const fileContent = fs.readFileSync(CUSTOM_CMDS_PATH, 'utf8');
    const cmds = JSON.parse(fileContent);
    res.json(cmds);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 15. Save/update custom/common commands list
app.post('/api/terminal/commands', (req, res) => {
  try {
    const { commands } = req.body;
    if (!Array.isArray(commands)) {
      return res.status(400).json({ error: 'Commands list must be an array.' });
    }
    
    // Validate each command
    for (const cmdObj of commands) {
      if (!cmdObj.cmd || !cmdObj.cmd.trim().startsWith('docker')) {
        return res.status(400).json({ error: `所有指令内容都必须以 "docker" 开头！非法指令: "${cmdObj.cmd || ''}"` });
      }
      if (!cmdObj.name || !cmdObj.name.trim()) {
        return res.status(400).json({ error: '按钮名称不能为空。' });
      }
    }
    
    fs.writeFileSync(CUSTOM_CMDS_PATH, JSON.stringify(commands, null, 2), 'utf8');
    res.json({ success: true, message: '常用命令列表保存成功。' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const WEBDAV_CONFIG_PATH = path.join(CONFIG_DIR, 'webdav_config.json');

function getWebDavConfig() {
  if (!fs.existsSync(WEBDAV_CONFIG_PATH)) {
    return { url: '', username: '', password: '', directory: '/composemgt_backups', autoBackup: false };
  }
  try {
    return JSON.parse(fs.readFileSync(WEBDAV_CONFIG_PATH, 'utf8'));
  } catch (e) {
    return { url: '', username: '', password: '', directory: '/composemgt_backups', autoBackup: false };
  }
}

function buildBackupPayload() {
  const compose = fs.existsSync(COMPOSE_FILE_PATH) ? fs.readFileSync(COMPOSE_FILE_PATH, 'utf8') : '';
  const env = fs.existsSync(ENV_FILE_PATH) ? fs.readFileSync(ENV_FILE_PATH, 'utf8') : '';
  let custom_commands = DEFAULT_COMMANDS;
  if (fs.existsSync(CUSTOM_CMDS_PATH)) {
    try {
      custom_commands = JSON.parse(fs.readFileSync(CUSTOM_CMDS_PATH, 'utf8'));
    } catch (e) {}
  }
  return {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    compose,
    env,
    custom_commands
  };
}

async function webdavRequest(config, method, subPath = '', headers = {}, body = null) {
  let url = config.url;
  if (!url.endsWith('/')) url += '/';
  
  let dir = config.directory.replace(/^\/+|\/+$/g, '');
  let fullUrl = url;
  if (dir) {
    fullUrl += dir + '/';
  }
  if (subPath) {
    fullUrl += subPath.replace(/^\/+/, '');
  }

  const authHeader = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
  
  const options = {
    method,
    headers: {
      'Authorization': authHeader,
      ...headers
    }
  };
  if (body !== null) {
    options.body = body;
  }

  const res = await fetch(fullUrl, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WebDAV 响应状态 ${res.status}: ${text || res.statusText}`);
  }
  return res;
}

async function ensureDirectoryExists(config) {
  let url = config.url;
  if (!url.endsWith('/')) url += '/';
  let dir = config.directory.replace(/^\/+|\/+$/g, '');
  if (!dir) return;

  const authHeader = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
  const fullUrl = url + dir + '/';
  
  try {
    const checkRes = await fetch(fullUrl, {
      method: 'PROPFIND',
      headers: {
        'Authorization': authHeader,
        'Depth': '0'
      }
    });
    if (checkRes.ok) {
      return;
    }
  } catch (e) {}

  const mkcolRes = await fetch(fullUrl, {
    method: 'MKCOL',
    headers: {
      'Authorization': authHeader
    }
  });
  if (!mkcolRes.ok && mkcolRes.status !== 405 && mkcolRes.status !== 409) {
    const text = await mkcolRes.text();
    throw new Error(`创建备份目录失败: ${mkcolRes.statusText} (${text})`);
  }
}

async function executeWebDavBackup(config) {
  await ensureDirectoryExists(config);
  const payload = buildBackupPayload();
  const dateStr = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const backupFilename = `composemgt_backup_${dateStr}.json`;
  await webdavRequest(config, 'PUT', backupFilename, { 'Content-Type': 'application/json' }, JSON.stringify(payload, null, 2));
  console.log(`☁️ Successfully backed up to WebDAV: ${backupFilename}`);
}

// 16. Local Export configuration
app.get('/api/backup/export', (req, res) => {
  try {
    const payload = buildBackupPayload();
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 17. Local Import configuration
app.post('/api/backup/import', (req, res) => {
  try {
    const { compose, env, custom_commands } = req.body;
    if (compose === undefined || env === undefined) {
      return res.status(400).json({ error: '备份文件结构不完整，缺少 compose 或 env。' });
    }

    if (fs.existsSync(COMPOSE_FILE_PATH)) {
      fs.writeFileSync(COMPOSE_FILE_PATH + '.bak', fs.readFileSync(COMPOSE_FILE_PATH));
    }
    if (fs.existsSync(ENV_FILE_PATH)) {
      fs.writeFileSync(ENV_FILE_PATH + '.bak', fs.readFileSync(ENV_FILE_PATH));
    }

    fs.writeFileSync(COMPOSE_FILE_PATH, compose, 'utf8');
    fs.writeFileSync(ENV_FILE_PATH, env, 'utf8');
    
    if (custom_commands && Array.isArray(custom_commands)) {
      fs.writeFileSync(CUSTOM_CMDS_PATH, JSON.stringify(custom_commands, null, 2), 'utf8');
    }

    res.json({ success: true, message: '备份配置已导入。' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 18. Get WebDAV configuration
app.get('/api/webdav/config', (req, res) => {
  res.json(getWebDavConfig());
});

// 19. Save WebDAV configuration
app.post('/api/webdav/config', (req, res) => {
  try {
    const { url, username, password, directory, autoBackup } = req.body;
    if (!url || !username || !password) {
      return res.status(400).json({ error: '所有 WebDAV 配置项均为必填项。' });
    }
    const config = { url, username, password, directory: directory || '/composemgt_backups', autoBackup: !!autoBackup };
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o755 });
    fs.writeFileSync(WEBDAV_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 20. Test WebDAV connection
app.post('/api/webdav/test', async (req, res) => {
  try {
    const { url, username, password, directory } = req.body;
    const config = { url, username, password, directory };
    await ensureDirectoryExists(config);
    
    const testFilename = 'connection_test.txt';
    await webdavRequest(config, 'PUT', testFilename, { 'Content-Type': 'text/plain' }, 'ComposeMgt Connection Test');
    await webdavRequest(config, 'DELETE', testFilename);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 21. Trigger WebDAV backup manually
app.post('/api/webdav/backup', async (req, res) => {
  try {
    const config = getWebDavConfig();
    if (!config.url || !config.username || !config.password) {
      return res.status(400).json({ error: '请先完成 WebDAV 云盘配置！' });
    }
    await executeWebDavBackup(config);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 22. List backups on WebDAV
app.get('/api/webdav/backups', async (req, res) => {
  try {
    const config = getWebDavConfig();
    if (!config.url || !config.username || !config.password) {
      return res.json([]);
    }
    await ensureDirectoryExists(config);
    
    const listRes = await webdavRequest(config, 'PROPFIND', '', { 'Depth': '1' });
    const xml = await listRes.text();
    
    // Log raw XML for debugging (first 500 chars)
    console.log(`📋 WebDAV PROPFIND response (first 500 chars): ${xml.substring(0, 500)}`);
    
    // Robust regex: match <response>, <D:response>, <d:response>, <DAV:response>, etc.
    // The namespace prefix is optional: (?:[a-zA-Z0-9]+:)? matches zero or one prefix
    const responseRegex = /<(?:[a-zA-Z0-9]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/gi;
    const backups = [];
    let match;
    
    while ((match = responseRegex.exec(xml)) !== null) {
      const segment = match[0];
      
      // Extract href (handles all namespace prefix variants)
      const hrefMatch = segment.match(/<(?:[a-zA-Z0-9]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?href>/i);
      const sizeMatch = segment.match(/<(?:[a-zA-Z0-9]+:)?getcontentlength[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?getcontentlength>/i);
      const dateMatch = segment.match(/<(?:[a-zA-Z0-9]+:)?getlastmodified[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?getlastmodified>/i);
      
      if (hrefMatch) {
        const decodedHref = decodeURIComponent(hrefMatch[1]);
        if (decodedHref.endsWith('.json') && decodedHref.includes('composemgt_backup')) {
          const filename = decodedHref.split('/').pop();
          backups.push({
            filename,
            size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
            date: dateMatch ? dateMatch[1] : 'Unknown'
          });
        }
      }
    }
    
    console.log(`📋 WebDAV backups found: ${backups.length}`);
    backups.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(backups);
  } catch (error) {
    console.error('WebDAV list backups error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 23. Restore configuration from WebDAV file
app.post('/api/webdav/restore', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ error: '请指定要恢复的备份文件名。' });
    }
    const config = getWebDavConfig();
    if (!config.url || !config.username || !config.password) {
      return res.status(400).json({ error: 'WebDAV 未正确配置。' });
    }
    
    const getRes = await webdavRequest(config, 'GET', filename);
    const backupPayload = await getRes.json();
    
    if (!backupPayload.compose || !backupPayload.env) {
      return res.status(400).json({ error: '拉取的云端备份格式不合法，缺少 compose 或 env。' });
    }

    if (fs.existsSync(COMPOSE_FILE_PATH)) {
      fs.writeFileSync(COMPOSE_FILE_PATH + '.bak', fs.readFileSync(COMPOSE_FILE_PATH));
    }
    if (fs.existsSync(ENV_FILE_PATH)) {
      fs.writeFileSync(ENV_FILE_PATH + '.bak', fs.readFileSync(ENV_FILE_PATH));
    }

    fs.writeFileSync(COMPOSE_FILE_PATH, backupPayload.compose, 'utf8');
    fs.writeFileSync(ENV_FILE_PATH, backupPayload.env, 'utf8');
    
    if (backupPayload.custom_commands && Array.isArray(backupPayload.custom_commands)) {
      fs.writeFileSync(CUSTOM_CMDS_PATH, JSON.stringify(backupPayload.custom_commands, null, 2), 'utf8');
    }
    
    res.json({ success: true, message: '成功从 WebDAV 云端备份中恢复配置！' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ensure the persisted config dir exists and, on first run, seed each config
// file from older locations so existing settings/defaults are not lost:
//   1) previous host-mounted file at $WORK_DIR/composemgt/<file>
//   2) the default baked into the image at <manager>/<file>
function ensurePersistedConfig() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o755 });
      console.log(`📁 Created panel config dir: ${CONFIG_DIR}`);
    }
    const seed = (fileName, dest) => {
      if (fs.existsSync(dest)) return;
      const candidates = [
        path.join(WORK_DIR, 'composemgt', fileName),
        path.resolve(__dirname, fileName)
      ];
      for (const c of candidates) {
        try {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) {
            fs.copyFileSync(c, dest);
            console.log(`📋 Seeded ${fileName} into config dir from ${c}`);
            return;
          }
        } catch (e) { /* ignore and try next */ }
      }
    };
    seed('webdav_config.json', WEBDAV_CONFIG_PATH);
    seed('custom_commands.json', CUSTOM_CMDS_PATH);
  } catch (e) {
    console.error('⚠️  Failed to prepare persisted config dir:', e.message);
  }
}

// Initialize required directories and files for fresh deployment
function initializeEnvironment() {
  console.log('🔍 Checking environment initialization...');

  // 0. Ensure the persisted config dir exists and seed it from older locations
  //    (baked image defaults / previous host-mounted files) so webdav config and
  //    custom commands survive container rebuilds.
  ensurePersistedConfig();

  // 1. Ensure data directory exists
  const dataDir = path.dirname(COMPOSE_FILE_PATH);
  if (!fs.existsSync(dataDir)) {
    console.log(`📁 Creating data directory: ${dataDir}`);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
  }

  // 2. Ensure .env file exists with default values
  if (!fs.existsSync(ENV_FILE_PATH)) {
    console.log(`📝 Creating default .env file: ${ENV_FILE_PATH}`);
    const envDir = path.dirname(ENV_FILE_PATH);
    if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true, mode: 0o755 });
    const defaultEnv = `# ComposeMgt 默认环境变量配置
# 此文件在全新部署时自动生成

# Tailscale 主机 IP（用于端口绑定）
TS_HOST_IP=100.101.102.100

# Docker 网络子网前缀（D_Home 网络使用）
SUBNET_PREFIX=172.18.0

# 时区设置
TZ=Asia/Shanghai

# PostgreSQL 配置
POSTGRES_PASSWORD=your_secure_password_here

# HCA Family 管理密码
HCA_ADMIN_PASSWORD=admin123

# Grok2API 配置
LOG_LEVEL=INFO
SERVER_HOST=0.0.0.0
SERVER_PORT=8000
SERVER_WORKERS=1
ACCOUNT_STORAGE=local
ACCOUNT_LOCAL_PATH=data/accounts.db
`;
    fs.writeFileSync(ENV_FILE_PATH, defaultEnv, { encoding: 'utf8', mode: 0o644 });
  }

  // 3. Ensure compose.yml exists (should already exist in repo)
  if (!fs.existsSync(COMPOSE_FILE_PATH)) {
    console.warn(`⚠️  compose.yml not found at ${COMPOSE_FILE_PATH}`);
  }

  // 4. Scan the stack (include files or legacy single block) and create each
  //    container's data directories + env_file placeholders. Relative paths are
  //    resolved against each service's own base directory.
  if (fs.existsSync(COMPOSE_FILE_PATH)) {
    try {
      const serviceEntries = readAllServiceEntries();
      const createdDirs = [];

      for (const [serviceName, serviceConfig] of serviceEntries) {
        const baseDir = serviceConfig.__baseDir || dataDir;

        // Ensure any env_file referenced by the service exists. docker compose
        // fails to start if an env_file is missing, so on a fresh deploy we
        // create an empty placeholder (under the service's own directory).
        if (serviceConfig.env_file) {
          const envFiles = Array.isArray(serviceConfig.env_file)
            ? serviceConfig.env_file
            : [serviceConfig.env_file];
          for (const ef of envFiles) {
            if (typeof ef !== 'string') continue;
            const fullEnv = resolveHostPathForCreation(ef, baseDir);
            if (!fullEnv) continue;
            if (!fs.existsSync(fullEnv)) {
              fs.mkdirSync(path.dirname(fullEnv), { recursive: true, mode: 0o755 });
              fs.writeFileSync(fullEnv, '', { encoding: 'utf8', mode: 0o644 });
              createdDirs.push(path.relative(WORK_DIR, fullEnv));
            }
          }
        }

        if (!serviceConfig.volumes) continue;
        const readOnlyMountError = getReadOnlyFileMountError(
          serviceName,
          serviceConfig.volumes,
          baseDir
        );
        if (readOnlyMountError) console.warn(`⚠️  ${readOnlyMountError}`);

        for (const volumeEntry of serviceConfig.volumes) {
          let source = '';
          let targetAndMode = '';
          if (typeof volumeEntry === 'string') {
            const parsedVolume = splitVolumeEntry(volumeEntry);
            if (!parsedVolume.hasTarget) continue;
            source = parsedVolume.source;
            targetAndMode = parsedVolume.targetAndMode;
          } else if (typeof volumeEntry === 'object' && volumeEntry.source) {
            source = volumeEntry.source;
            targetAndMode = volumeEntry.read_only ? ':ro' : '';
          }

          const effectiveSource = effectiveVolumeSource(source, getVolumeInterpolationEnv(baseDir));
          const fullPath = resolveHostPathForCreation(source, baseDir);
          if (!effectiveSource || !fullPath) continue;

          const isRelativeSource = effectiveSource === '.'
            || effectiveSource.startsWith('./')
            || effectiveSource.startsWith('../');
          if (!isRelativeSource) continue;

          const isFileMount = !effectiveSource.endsWith('/') && !!path.extname(fullPath);
          if (isFileMount && isReadOnlyVolumeTarget(targetAndMode)) {
            continue;
          }

          const result = ensureHostPathExists(fullPath, effectiveSource);
          if (result.created) createdDirs.push(path.relative(WORK_DIR, fullPath));
        }
      }

      if (createdDirs.length > 0) {
        const uniqueDirs = [...new Set(createdDirs)];
        console.log(`📦 Created container data directories: ${uniqueDirs.join(', ')}`);
      }
    } catch (err) {
      console.error(`⚠️  Failed to scan compose.yml for volume initialization: ${err.message}`);
    }
  }

  console.log('✅ Environment initialization complete');
}

// Automated WebDAV Daily Backup Loop
let lastBackupDate = '';
setInterval(async () => {
  try {
    const config = getWebDavConfig();
    if (!config.autoBackup || !config.url || !config.username || !config.password) {
      return;
    }
    const today = new Date().toISOString().split('T')[0];
    if (lastBackupDate === today) {
      return;
    }
    const hour = new Date().getHours();
    if (hour === 3) {
      console.log('⏰ Triggering automated daily WebDAV backup...');
      await executeWebDavBackup(config);
      lastBackupDate = today;
    }
  } catch (err) {
    console.error('Automated WebDAV backup failed:', err.message);
  }
}, 60 * 60 * 1000);

// Start Server after checking docker
const PORT = process.env.PORT || 9988;

// Initialize environment before starting server
initializeEnvironment();

checkDockerAvailability().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Docker Compose Management Server running at http://localhost:${PORT}`);
    console.log(`📂 Managing file: ${COMPOSE_FILE_PATH}`);
  });
});
