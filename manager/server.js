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

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

const COMPOSE_FILE_PATH = path.resolve(__dirname, '../data/compose.yml');
const ENV_FILE_PATH = path.resolve(__dirname, '../data/.env');

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

// Run exec command wrapped in Promise
function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: path.resolve(__dirname, '../data') }, (error, stdout, stderr) => {
      if (error) {
        reject(error.message + '\n' + stderr);
      } else {
        resolve(stdout);
      }
    });
  });
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
      // Find IP
      let ip = 'Dynamic';
      if (service.networks && service.networks.D_Home && service.networks.D_Home.ipv4_address) {
        let rawIp = service.networks.D_Home.ipv4_address;
        // Resolve environment variable
        rawIp = rawIp.replace('${SUBNET_PREFIX}', subnetPrefix);
        rawIp = rawIp.replace('$SUBNET_PREFIX', subnetPrefix);
        ip = rawIp;
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
        image: service.image || (service.build ? `Build (${service.build})` : 'Custom build'),
        ip,
        ports,
        environment: service.environment || {},
        volumes: service.volumes || []
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
app.get('/api/status', async (req, res) => {
  const envs = getEnvVariables();
  res.json({
    mockMode: isMockMode,
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

// 8. Get service logs (Static snapshot)
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
    cwd: path.resolve(__dirname, '../data')
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

// 9. Add new service to compose.yml
app.post('/api/services', async (req, res) => {
  try {
    const { name, image, publishedPort, targetPort, ipSuffix, environment, volumes } = req.body;
    
    if (!name || !image) {
      return res.status(400).json({ error: 'Service name and image are required.' });
    }

    if (!fs.existsSync(COMPOSE_FILE_PATH)) {
      return res.status(500).json({ error: 'compose.yml file not found.' });
    }

    const fileContent = fs.readFileSync(COMPOSE_FILE_PATH, 'utf8');
    const doc = YAML.parseDocument(fileContent);

    if (doc.getIn(['services', name])) {
      return res.status(400).json({ error: `Service "${name}" already exists.` });
    }

    // Build the new service structure
    const newService = {
      container_name: name,
      image: image,
    };

    // Add service base defaults
    // Since we use YAML anchors, we need to create the exact reference in YAML
    // But programmatically, YAML document API will output it cleanly.
    // Let's set the base anchor reference if possible, or build it manually:
    // We can define standard restart, logging, network setup
    
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

    // Add env vars
    if (environment && Object.keys(environment).length > 0) {
      newService.environment = environment;
    }

    // Add volumes
    if (volumes && volumes.length > 0) {
      newService.volumes = volumes;
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

    // Insert service into the document
    doc.setIn(['services', name], newService);

    // Save compose.yml back to disk (preserving other sections, formatting, comments)
    fs.writeFileSync(COMPOSE_FILE_PATH, doc.toString(), 'utf8');

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

// Start Server after checking docker
const PORT = process.env.PORT || 9988;
checkDockerAvailability().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Docker Compose Management Server running at http://localhost:${PORT}`);
    console.log(`📂 Managing file: ${COMPOSE_FILE_PATH}`);
  });
});
