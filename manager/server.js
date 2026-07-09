const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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
      if (volume.source && volume.target) return `${volume.source}:${volume.target}`;
      if (volume.target) return String(volume.target);
    }
    return '';
  }).filter(Boolean);
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
    }
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
    const fileContent = fs.readFileSync(COMPOSE_FILE_PATH, 'utf8');
    const doc = YAML.parse(fileContent);
    
    if (!doc || !doc.services) {
      return [];
    }

    const envs = getEnvVariables();
    const subnetPrefix = envs.SUBNET_PREFIX || '172.18.0';

    return Object.entries(doc.services).map(([name, service]) => {
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
        environment: service.environment || {},
        volumes: service.volumes || [],
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

    const existingServices = fs.existsSync(COMPOSE_FILE_PATH)
      ? YAML.parse(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'))?.services || {}
      : {};
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
      const compose = YAML.parse(fs.readFileSync(COMPOSE_FILE_PATH, 'utf8'));
      baseServiceError = getBaseServiceValidationError(compose?.services || {});
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

// 8. Git Pull + Build + Recreate for local build services
app.post('/api/services/:name/build-update', async (req, res) => {
  const { name } = req.params;
  console.log(`Git pull and rebuild service: ${name}`);

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

    // Check if it's a git repository
    const gitDir = path.join(contextPath, '.git');
    if (!fs.existsSync(gitDir)) {
      return res.status(400).json({
        error: `构建上下文目录 "${contextPath}" 不是一个 Git 仓库（未找到 .git 目录），无法执行 git pull。请确认该目录是通过 git clone 获得的。`
      });
    }

    // Step 1: Run git pull in the build context directory
    const gitOutput = await new Promise((resolve, reject) => {
      exec('git pull', { cwd: contextPath, timeout: 30000 }, (error, stdout, stderr) => {
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
      output: `=== Git Pull (${service.buildContext}) ===\n${gitOutput}\n\n=== Docker Build & Recreate ===\n${buildOutput}`
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

    const fileContent = fs.readFileSync(COMPOSE_FILE_PATH, 'utf8');
    const doc = YAML.parseDocument(fileContent);

    const services = doc.get('services')?.toJSON() || {};
    if (services[name] && !isEdit) {
      return res.status(400).json({ error: `服务 ID "${name}" 已经存在。` });
    }

    try {
      await assertBaseServiceDeployable(services);
    } catch (baseError) {
      return res.status(400).json({ error: baseError.message });
    }

    const isHostNet = (networkMode === 'host');

    // Check port conflict
    if (publishedPort && !isHostNet) {
      const pubPortInt = parseInt(publishedPort);
      for (const [srvName, srvConfig] of Object.entries(services)) {
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
      for (const [srvName, srvConfig] of Object.entries(services)) {
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

    // Add env vars
    if (environment && Object.keys(environment).length > 0) {
      newService.environment = environment;
    }

    // Add volumes
    if (volumes && volumes.length > 0) {
      newService.volumes = volumes;

      // Create volume directories for relative paths
      const projectRoot = path.resolve(WORK_DIR, '..');
      for (const volumeEntry of volumes) {
        let hostPath = '';

        if (typeof volumeEntry === 'string') {
          const parts = volumeEntry.split(':');
          if (parts.length >= 2) {
            hostPath = parts[0];
          }
        }

        // Only process relative paths starting with './'
        if (hostPath.startsWith('./')) {
          const relativePath = hostPath.substring(2);
          const fullPath = path.join(projectRoot, relativePath);

          // For file mounts, create parent directory; for directory mounts, create the directory itself
          let dirToCreate;
          if (hostPath.endsWith('/') || !path.extname(fullPath)) {
            // Likely a directory mount (no extension or ends with /)
            dirToCreate = fullPath;
          } else {
            // File mount, create parent directory
            dirToCreate = path.dirname(fullPath);
          }

          if (!fs.existsSync(dirToCreate)) {
            console.log(`📁 Creating volume directory: ${relativePath}`);
            fs.mkdirSync(dirToCreate, { recursive: true, mode: 0o755 });
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

    // Insert service into the document. New services are appended to the end;
    // existing services keep their current position.
    doc.setIn(['services', name], newService);

    // Save compose.yml back to disk (preserving other sections, formatting, comments)
    let nextComposeContent = doc.toString();
    if (!isEdit) {
      nextComposeContent = addServiceSectionComment(
        nextComposeContent,
        name,
        getServiceSectionComment(Object.keys(services).length + 1, name, isHostNet ? '' : ipSuffix)
      );
    }
    fs.writeFileSync(COMPOSE_FILE_PATH, nextComposeContent, 'utf8');

    if (isMockMode) {
      mockState[name] = { state: 'exited', status: 'Created', health: '' };
    }

    res.json({ success: true, message: `Successfully added service "${name}" to compose.yml` });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    // Read and parse doc
    const fileContent = fs.readFileSync(COMPOSE_FILE_PATH, 'utf8');
    const doc = YAML.parseDocument(fileContent);

    const serviceNode = doc.getIn(['services', name]);
    if (!serviceNode) {
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

    // Clean up .env variables uniquely referenced by this service
    try {
      const serviceObj = serviceNode.toJSON();
      const serviceStr = JSON.stringify(serviceObj);
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

const CUSTOM_CMDS_PATH = path.resolve(__dirname, 'custom_commands.json');
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

const WEBDAV_CONFIG_PATH = path.resolve(__dirname, 'webdav_config.json');

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

// Initialize required directories and files for fresh deployment
function initializeEnvironment() {
  console.log('🔍 Checking environment initialization...');

  // 1. Ensure data directory exists
  const dataDir = path.dirname(COMPOSE_FILE_PATH);
  if (!fs.existsSync(dataDir)) {
    console.log(`📁 Creating data directory: ${dataDir}`);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
  }

  // 2. Ensure .env file exists with default values
  if (!fs.existsSync(ENV_FILE_PATH)) {
    console.log(`📝 Creating default .env file: ${ENV_FILE_PATH}`);
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

  // 4. Scan compose.yml and create container data directories
  if (fs.existsSync(COMPOSE_FILE_PATH)) {
    try {
      const composeContent = fs.readFileSync(COMPOSE_FILE_PATH, 'utf8');
      const doc = YAML.parse(composeContent);
      const services = doc?.services || {};

      const projectRoot = path.resolve(dataDir, '..');
      const createdDirs = [];

      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        if (!serviceConfig.volumes) continue;

        for (const volumeEntry of serviceConfig.volumes) {
          let hostPath = '';

          if (typeof volumeEntry === 'string') {
            const parts = volumeEntry.split(':');
            if (parts.length >= 2) {
              hostPath = parts[0];
            }
          } else if (typeof volumeEntry === 'object' && volumeEntry.source) {
            hostPath = volumeEntry.source;
          }

          // Only process relative paths starting with './'
          if (hostPath.startsWith('./')) {
            // Remove leading './' and resolve relative to project root
            const relativePath = hostPath.substring(2);
            const fullPath = path.join(projectRoot, relativePath);

            // For file mounts, create parent directory; for directory mounts, create the directory itself
            let dirToCreate;
            if (hostPath.endsWith('/') || !path.extname(fullPath)) {
              // Likely a directory mount (no extension or ends with /)
              dirToCreate = fullPath;
            } else {
              // File mount, create parent directory
              dirToCreate = path.dirname(fullPath);
            }

            if (!fs.existsSync(dirToCreate)) {
              fs.mkdirSync(dirToCreate, { recursive: true, mode: 0o755 });
              createdDirs.push(relativePath); // Track created path
            }
          }
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
