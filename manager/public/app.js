// State Management
let servicesState = [];
let systemStatus = {};
let currentTab = 'containers';
let containerFilter = 'all';
let containerSearch = '';
let activeLogService = null;
let activeLogInterval = null;
let logEventSource = null;

// DOM Elements
const sidebarNav = document.querySelector('.sidebar-nav');
const navItems = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');
const btnRefresh = document.getElementById('btn-refresh');
const btnAddContainer = document.getElementById('btn-add-container');
const containerGrid = document.getElementById('container-list-grid');

// System status widgets
const systemModeText = document.getElementById('system-mode-text');
const metaHostIp = document.getElementById('meta-host-ip');
const metaSubnet = document.getElementById('meta-subnet');
const metaPlatform = document.getElementById('meta-platform');

// Stats counters
const statTotal = document.getElementById('stat-total');
const statRunning = document.getElementById('stat-running');
const statStopped = document.getElementById('stat-stopped');

// Search & Filter
const searchInput = document.getElementById('search-input');
const filterBtns = document.querySelectorAll('.filter-btn');

// Alert Banner
const alertBanner = document.getElementById('alert-banner');
const alertMessage = alertBanner.querySelector('.alert-message');
const alertClose = alertBanner.querySelector('.alert-close');

// Modal: Add Service
const modalAddService = document.getElementById('modal-add-service');
const formAddService = document.getElementById('form-add-service');
const ipPrefixDisplay = document.getElementById('ip-prefix-display');
const btnAddVolumeField = document.querySelector('.btn-add-field[data-type="volume"]');
const btnAddEnvField = document.querySelector('.btn-add-field[data-type="env"]');
const volumesList = document.getElementById('volumes-list');
const envList = document.getElementById('env-list');

// Modal: Logs
const modalLogs = document.getElementById('modal-logs');
const logsTitle = document.getElementById('logs-title');
const logsOutput = document.getElementById('logs-output');
const btnRefreshLogs = document.getElementById('btn-refresh-logs');

// Modal: Delete
const modalDeleteConfirm = document.getElementById('modal-delete-confirm');
const deleteServiceName = document.getElementById('delete-service-name');
const btnConfirmDelete = document.getElementById('btn-confirm-delete');

// Env Editor Elements
const envModeVisual = document.getElementById('env-mode-visual');
const envModeRaw = document.getElementById('env-mode-raw');
const envVisualContainer = document.getElementById('env-visual-container');
const envRawContainer = document.getElementById('env-raw-container');
const envKeysTbody = document.getElementById('env-keys-tbody');
const envRawTextarea = document.getElementById('env-raw-textarea');
const btnAddEnvRow = document.getElementById('btn-add-env');
const btnSaveEnv = document.getElementById('btn-save-env');

// Init application
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadSystemStatus().then(() => {
    loadServices();
    loadCustomCommands();
  });
});

// Setup Events
function setupEventListeners() {
  // Sidebar Navigation
  sidebarNav.addEventListener('click', (e) => {
    const navItem = e.target.closest('.nav-item');
    if (!navItem) return;
    
    navItems.forEach(item => item.classList.remove('active'));
    navItem.classList.add('active');
    
    const tabName = navItem.dataset.tab;
    currentTab = tabName;
    
    tabPanes.forEach(pane => pane.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    // Update header titles
    if (tabName === 'containers') {
      pageTitle.textContent = '容器管理';
      pageSubtitle.textContent = '管理所有 Docker Compose 服务及容器状态';
      btnAddContainer.classList.remove('hidden');
    } else if (tabName === 'env') {
      pageTitle.textContent = '.env 配置编辑';
      pageSubtitle.textContent = '管理全局容器编排的环境变量及主机参数';
      btnAddContainer.classList.add('hidden');
      loadEnvFile();
    } else if (tabName === 'terminal') {
      pageTitle.textContent = 'Docker 交互终端';
      pageSubtitle.textContent = '执行自定义的 Docker 与 Docker Compose 运维指令';
      btnAddContainer.classList.add('hidden');
    }
  });

  // Global actions
  btnRefresh.addEventListener('click', () => {
    const icon = btnRefresh.querySelector('svg');
    icon.classList.add('icon-spin-hover');
    if (currentTab === 'containers') {
      loadServices().finally(() => icon.classList.remove('icon-spin-hover'));
    } else {
      loadEnvFile().finally(() => icon.classList.remove('icon-spin-hover'));
    }
  });
  
  btnAddContainer.addEventListener('click', () => openModal(modalAddService));

  // Search & Filter
  searchInput.addEventListener('input', (e) => {
    containerSearch = e.target.value.toLowerCase().trim();
    renderServices();
  });

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      containerFilter = btn.dataset.filter;
      renderServices();
    });
  });

  // Modal Closures
  document.querySelectorAll('.modal-close-btn, .modal-cancel-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-backdrop');
      closeModal(modal);
    });
  });

  // Add Dynamic Fields in Service Creation
  btnAddVolumeField.addEventListener('click', () => addVolumeRow('', ''));
  btnAddEnvField.addEventListener('click', () => addEnvRow('', ''));

  // Bulk Env import listeners
  const btnToggleBulkEnv = document.getElementById('btn-toggle-bulk-env');
  const btnCancelBulkEnv = document.getElementById('btn-cancel-bulk-env');
  const btnParseBulkEnv = document.getElementById('btn-parse-bulk-env');
  const envBulkContainer = document.getElementById('env-bulk-container');
  const envBulkTextarea = document.getElementById('env-bulk-textarea');
  const btnAddEnvSingle = document.getElementById('btn-add-env-single');

  if (btnToggleBulkEnv) {
    btnToggleBulkEnv.addEventListener('click', () => {
      envList.classList.add('hidden');
      btnAddEnvSingle.classList.add('hidden');
      btnToggleBulkEnv.classList.add('hidden');
      envBulkContainer.classList.remove('hidden');
      envBulkTextarea.focus();
    });
  }

  if (btnCancelBulkEnv) {
    btnCancelBulkEnv.addEventListener('click', () => {
      envBulkContainer.classList.add('hidden');
      envList.classList.remove('hidden');
      btnAddEnvSingle.classList.remove('hidden');
      btnToggleBulkEnv.classList.remove('hidden');
      envBulkTextarea.value = '';
    });
  }

  if (btnParseBulkEnv) {
    btnParseBulkEnv.addEventListener('click', () => {
      const text = envBulkTextarea.value;
      const parsedObj = parseBulkEnv(text);
      
      const parsedKeys = Object.keys(parsedObj);
      if (parsedKeys.length === 0) {
        showAlert('未能解析出有效的环境变量，请检查格式！', 'error');
        return;
      }
      
      // Populate standard inputs
      parsedKeys.forEach(key => {
        addEnvRow(key, parsedObj[key]);
      });
      
      showAlert(`成功导入 ${parsedKeys.length} 个环境变量！`);
      
      // Hide bulk and restore standard list
      envBulkContainer.classList.add('hidden');
      envList.classList.remove('hidden');
      btnAddEnvSingle.classList.remove('hidden');
      btnToggleBulkEnv.classList.remove('hidden');
      envBulkTextarea.value = '';
    });
  }

  // Submit Add Service Form
  formAddService.addEventListener('submit', handleAddServiceSubmit);

  // Close Alert
  alertClose.addEventListener('click', () => alertBanner.classList.add('hidden'));

  // Logs Modal Refresher
  btnRefreshLogs.addEventListener('click', () => {
    if (activeLogService) loadServiceLogs(activeLogService);
  });

  // Delete Confirm Button
  btnConfirmDelete.addEventListener('click', handleDeleteConfirmClick);

  // Env Editor Mode Toggles
  envModeVisual.addEventListener('click', () => {
    envModeVisual.classList.add('active');
    envModeRaw.classList.remove('active');
    envVisualContainer.classList.remove('hidden');
    envRawContainer.classList.add('hidden');
    // Sync Raw to Visual
    syncRawToVisual();
  });

  envModeRaw.addEventListener('click', () => {
    envModeRaw.classList.add('active');
    envModeVisual.classList.remove('active');
    envRawContainer.classList.remove('hidden');
    envVisualContainer.classList.add('hidden');
    // Sync Visual to Raw
    syncVisualToRaw();
  });

  if (btnAddEnvRow) {
    btnAddEnvRow.addEventListener('click', () => addEnvTableRow('', ''));
  }
  btnSaveEnv.addEventListener('click', handleSaveEnvSubmit);

  // Terminal Command Executor
  const formTerminalCmd = document.getElementById('form-terminal-cmd');
  const terminalCmdInput = document.getElementById('terminal-cmd-input');
  const terminalConsoleOutput = document.getElementById('terminal-console-output');

  if (formTerminalCmd) {
    formTerminalCmd.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cmd = terminalCmdInput.value.trim();
      if (!cmd) return;

      // Intercept local clear commands
      if (cmd.toLowerCase() === 'clear' || cmd.toLowerCase() === 'cls') {
        terminalConsoleOutput.textContent = '$ 等待输入指令...\n例如在下方输入: docker stats --no-stream';
        terminalCmdInput.value = '';
        return;
      }

      terminalConsoleOutput.textContent += `\n\n$ ${cmd}\n正在执行...\n`;
      terminalConsoleOutput.scrollTop = terminalConsoleOutput.scrollHeight;

      try {
        const res = await fetch('/api/terminal/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        });
        const data = await res.json();
        
        if (!res.ok || data.error) {
          terminalConsoleOutput.textContent += `⚠️ 错误: ${data.error || '执行命令失败'}\n`;
        } else {
          if (data.stderr) {
            terminalConsoleOutput.textContent += `⚠️ 警告:\n${data.stderr}\n`;
          }
          terminalConsoleOutput.textContent += data.stdout || '（命令已成功运行，无任何标准输出）\n';
        }
      } catch (err) {
        terminalConsoleOutput.textContent += `⚠️ 无法连接后端服务器: ${err.message}\n`;
      }

      terminalCmdInput.value = '';
      terminalConsoleOutput.scrollTop = terminalConsoleOutput.scrollHeight;
    });
  }

  const btnClearTerminal = document.getElementById('btn-clear-terminal');
  if (btnClearTerminal) {
    btnClearTerminal.addEventListener('click', () => {
      if (terminalConsoleOutput) {
        terminalConsoleOutput.textContent = '$ 等待输入指令...\n例如在下方输入: docker stats --no-stream';
      }
    });
  }

  // Manage Quick Commands Modal Trigger
  const btnManageQuickCmds = document.getElementById('btn-manage-quick-cmds');
  if (btnManageQuickCmds) {
    btnManageQuickCmds.addEventListener('click', openManageCommandsModal);
  }

  // Add command row inside manager modal
  const btnAddCmdRow = document.getElementById('btn-add-cmd-row');
  if (btnAddCmdRow) {
    btnAddCmdRow.addEventListener('click', () => addCommandTableRow('', ''));
  }

  // Save commands inside manager modal
  const btnSaveCustomCmds = document.getElementById('btn-save-custom-cmds');
  if (btnSaveCustomCmds) {
    btnSaveCustomCmds.addEventListener('click', saveCustomCommands);
  }
}

// Helpers for Modals
function openModal(modal) {
  modal.classList.add('open');
}

function closeModal(modal) {
  modal.classList.remove('open');
  // If logs modal closed, close EventSource connection
  if (modal.id === 'modal-logs') {
    activeLogService = null;
    if (logEventSource) {
      logEventSource.close();
      logEventSource = null;
    }
  }
}

// Global Alerts
function showAlert(message, type = 'success') {
  alertBanner.className = `alert-banner ${type}`;
  alertMessage.textContent = message;
  alertBanner.classList.remove('hidden');
  
  // Auto dismiss after 8s
  setTimeout(() => {
    alertBanner.classList.add('hidden');
  }, 8000);
}

// Fetch System Config
async function loadSystemStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    systemStatus = data;

    // Set side panel values
    metaHostIp.textContent = data.envs.TS_HOST_IP || '-';
    metaSubnet.textContent = `${data.envs.SUBNET_PREFIX || '-'}.0/24`;
    metaPlatform.textContent = `${data.platform} (${data.nodeVersion})`;
    
    // Set form displays
    ipPrefixDisplay.textContent = `${data.envs.SUBNET_PREFIX || '172.18.0'}.`;

    if (data.mockMode) {
      systemModeText.textContent = '演示模式 (无 Docker)';
      systemModeText.parentElement.querySelector('.pulse-dot').className = 'pulse-dot status-mock';
    } else {
      systemModeText.textContent = 'Docker 已连接';
      systemModeText.parentElement.querySelector('.pulse-dot').className = 'pulse-dot status-online';
    }
  } catch (err) {
    console.error('Failed to load system status:', err);
    systemModeText.textContent = '后台离线';
    systemModeText.parentElement.querySelector('.pulse-dot').className = 'pulse-dot text-danger';
  }
}

// Fetch Compose Services list
async function loadServices() {
  containerGrid.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <span>正在查询 Docker 服务状态...</span>
    </div>
  `;

  try {
    const res = await fetch('/api/services');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    servicesState = data;
    renderServices();
  } catch (err) {
    showAlert(`加载容器服务失败: ${err.message}`, 'error');
    containerGrid.innerHTML = `
      <div class="loading-state text-danger">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <span>无法连接至后端，请检查 Node.js 服务是否正常启动。</span>
      </div>
    `;
  }
}

// Render dynamic services UI
function renderServices() {
  if (servicesState.length === 0) {
    containerGrid.innerHTML = `
      <div class="loading-state">
        <span>compose.yml 中未定义任何服务。</span>
      </div>
    `;
    updateStats(0, 0, 0);
    return;
  }

  // Calculate stats
  const total = servicesState.length;
  const running = servicesState.filter(s => s.status === 'running').length;
  const stopped = total - running;
  updateStats(total, running, stopped);

  // Filter & Search
  let filtered = servicesState.filter(service => {
    const matchSearch = service.name.toLowerCase().includes(containerSearch) ||
                        service.image.toLowerCase().includes(containerSearch) ||
                        service.ip.toLowerCase().includes(containerSearch);
    
    if (containerFilter === 'all') return matchSearch;
    if (containerFilter === 'running') return matchSearch && service.status === 'running';
    if (containerFilter === 'stopped') return matchSearch && service.status !== 'running';
    return matchSearch;
  });

  if (filtered.length === 0) {
    containerGrid.innerHTML = `
      <div class="loading-state">
        <span>未搜索到匹配的服务。</span>
      </div>
    `;
    return;
  }

  containerGrid.innerHTML = '';
  filtered.forEach(service => {
    const isRunning = service.status === 'running';
    const card = document.createElement('div');
    card.className = `container-card ${isRunning ? 'running' : 'stopped'}`;
    card.id = `card-${service.name}`;

    // Ports html
    let portsHtml = '';
    if (service.ports && service.ports.length > 0) {
      portsHtml = service.ports.map(p => {
        const url = `http://${systemStatus.envs?.TS_HOST_IP || 'localhost'}:${p.published}`;
        return `<a href="${url}" target="_blank" class="ip-link port-badge" title="点击访问外部端点">
          ${p.published}:${p.target} 
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        </a>`;
      }).join(' ');
    } else {
      portsHtml = '<span class="text-muted text-sm">无映射</span>';
    }

    // Health HTML
    const healthText = service.health ? ` (${service.health})` : '';

    card.innerHTML = `
      <div class="card-header-main">
        <div class="card-title-group">
          <h3>${service.name}</h3>
          <span class="image-tag" title="${service.image}">${service.image}</span>
        </div>
        <span class="badge ${isRunning ? 'badge-running' : 'badge-stopped'}">
          ${isRunning ? '运行中' : '已停止'}${healthText}
        </span>
      </div>
      
      <div class="card-details">
        <div class="detail-row">
          <span class="detail-label">容器名称</span>
          <span class="detail-val font-mono">${service.container_name}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">内部网静态 IP</span>
          <span class="detail-val font-mono">${service.ip}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">网络映射端口</span>
          <div class="detail-val">${portsHtml}</div>
        </div>
        <div class="detail-row">
          <span class="detail-label">运行说明</span>
          <span class="detail-val text-muted text-sm">${service.statusText || '-'}</span>
        </div>
      </div>
      
      <div class="card-actions">
        <div class="action-left">
          ${isRunning ? 
            `<button class="btn btn-secondary btn-xs" onclick="triggerAction('${service.name}', 'stop')" title="停止服务">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect></svg>
              停止
            </button>
            <button class="btn btn-secondary btn-xs" onclick="triggerAction('${service.name}', 'restart')" title="重启服务">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              重启
            </button>`
            : 
            `<button class="btn btn-primary btn-xs" onclick="triggerAction('${service.name}', 'start')" title="启动服务">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              启动
            </button>`
          }
        </div>
        <div class="action-right">
          <button class="btn btn-secondary btn-xs" onclick="showLogsModal('${service.name}')" title="查看容器日志">
            日志
          </button>
          <button class="btn btn-secondary btn-xs" onclick="triggerAction('${service.name}', 'recreate')" title="强制重建并重启服务">
            重建
          </button>
          <button class="btn btn-secondary btn-xs" onclick="triggerAction('${service.name}', 'pull')" title="拉取最新镜像并重启">
            更新
          </button>
          <button class="btn btn-danger btn-xs" onclick="showDeleteModal('${service.name}')" title="从编排中删除此服务">
            &times;
          </button>
        </div>
      </div>
    `;
    containerGrid.appendChild(card);
  });
}

function updateStats(total, running, stopped) {
  statTotal.textContent = total;
  statRunning.textContent = running;
  statStopped.textContent = stopped;
}

// Handle service commands (Start, Stop, Restart, Recreate, Pull)
async function triggerAction(serviceName, action) {
  const card = document.getElementById(`card-${serviceName}`);
  const actionsContainer = card.querySelector('.card-actions');
  const originalHtml = actionsContainer.innerHTML;
  
  // Set card loading state
  actionsContainer.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; font-size:0.75rem; color:var(--color-text-secondary);">
      <div class="spinner" style="width:12px; height:12px; border-width:2px;"></div>
      正在执行 ${action.toUpperCase()}...
    </div>
  `;

  try {
    const res = await fetch(`/api/services/${serviceName}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '执行命令失败');
    
    showAlert(`服务 ${serviceName} 执行 ${action} 操作成功！`);
    
    // Reload state after short sleep to allow Docker daemon to reflect status
    setTimeout(loadServices, 1500);
  } catch (err) {
    showAlert(`操作失败: ${err.message}`, 'error');
    actionsContainer.innerHTML = originalHtml;
  }
}

// Logs Console Drawer (SSE real-time streaming)
function showLogsModal(serviceName) {
  activeLogService = serviceName;
  logsTitle.textContent = `容器实时日志 - ${serviceName}`;
  logsOutput.textContent = '正在建立实时日志流连接...\n';
  openModal(modalLogs);

  // Close existing log connection if any
  if (logEventSource) {
    logEventSource.close();
  }

  // Open EventSource connection
  logEventSource = new EventSource(`/api/services/${serviceName}/logs/stream`);

  logEventSource.onmessage = (event) => {
    // Append new logs line
    logsOutput.textContent += event.data + '\n';
    // Auto scroll to bottom
    logsOutput.scrollTop = logsOutput.scrollHeight;
  };

  logEventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    // Note: EventSource automatically reconnects, we just display a message
    logsOutput.textContent += '⚠️ 实时日志连接断开，正在尝试自动重连...\n';
  };
}

// Service Deletion Confirmation
let serviceToDelete = null;

function showDeleteModal(serviceName) {
  serviceToDelete = serviceName;
  deleteServiceName.textContent = serviceName;
  openModal(modalDeleteConfirm);
}

async function handleDeleteConfirmClick() {
  if (!serviceToDelete) return;
  const name = serviceToDelete;
  closeModal(modalDeleteConfirm);
  
  showAlert(`正在停止并删除服务 "${name}"...`, 'info');
  
  try {
    const res = await fetch(`/api/services/${name}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    showAlert(`服务 "${name}" 已成功删除！`);
    loadServices();
  } catch (err) {
    showAlert(`删除服务失败: ${err.message}`, 'error');
  } finally {
    serviceToDelete = null;
  }
}

// Service Creation Dialog: dynamic fields handlers
function addVolumeRow(hostVal = '', containerVal = '') {
  const row = document.createElement('div');
  row.className = 'dynamic-row';
  row.innerHTML = `
    <input type="text" placeholder="./host/path" value="${hostVal}">
    <span style="align-self:center">:</span>
    <input type="text" placeholder="/container/path" value="${containerVal}">
    <button type="button" class="btn-icon-danger" onclick="this.parentElement.remove()">&times;</button>
  `;
  volumesList.appendChild(row);
}

function addEnvRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'dynamic-row';
  row.innerHTML = `
    <input type="text" placeholder="KEY" value="${key}" style="font-family:var(--font-mono); font-weight:600;">
    <span style="align-self:center">=</span>
    <input type="text" placeholder="value" value="${val}">
    <button type="button" class="btn-icon-danger" onclick="this.parentElement.remove()">&times;</button>
  `;
  envList.appendChild(row);
}

async function handleAddServiceSubmit(e) {
  e.preventDefault();
  
  const name = document.getElementById('srv-name').value.trim();
  const image = document.getElementById('srv-image').value.trim();
  const publishedPort = document.getElementById('srv-pub-port').value;
  const targetPort = document.getElementById('srv-tgt-port').value;
  const ipSuffix = document.getElementById('srv-ip-suffix').value;

  // Compile volumes
  const volumes = [];
  volumesList.querySelectorAll('.dynamic-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    const host = inputs[0].value.trim();
    const container = inputs[1].value.trim();
    if (host && container) {
      volumes.push(`${host}:${container}`);
    }
  });

  // Compile environment variables
  const environment = {};
  envList.querySelectorAll('.dynamic-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    const key = inputs[0].value.trim();
    const value = inputs[1].value.trim();
    if (key) {
      environment[key] = value;
    }
  });

  const payload = {
    name,
    image,
    publishedPort: publishedPort ? parseInt(publishedPort) : undefined,
    targetPort: targetPort ? parseInt(targetPort) : undefined,
    ipSuffix: ipSuffix ? parseInt(ipSuffix) : undefined,
    environment,
    volumes
  };

  try {
    const res = await fetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    showAlert(`容器服务 "${name}" 创建并成功插入 compose.yml！`);
    closeModal(modalAddService);
    
    // Reset form
    formAddService.reset();
    volumesList.innerHTML = '';
    envList.innerHTML = '';
    
    loadServices();
  } catch (err) {
    showAlert(`新增容器失败: ${err.message}`, 'error');
  }
}

// .env Editor Functions
let loadedEnvObject = {};
let loadedEnvRaw = '';

let loadedEnvGrouping = { global: [], services: {} };

async function loadEnvFile() {
  try {
    const res = await fetch('/api/env');
    const data = await res.json();
    loadedEnvObject = data.envVars;
    loadedEnvRaw = data.rawContent;
    loadedEnvGrouping = data.grouping || { global: [], services: {} };

    // Fill UI
    envRawTextarea.value = data.rawContent;
    
    if (envModeVisual.classList.contains('active')) {
      syncRawToVisual();
    }
  } catch (err) {
    showAlert(`加载环境变量配置文件失败: ${err.message}`, 'error');
  }
}

function syncRawToVisual() {
  const container = document.getElementById('env-groups-container');
  if (!container) return;
  container.innerHTML = '';
  
  // 1. Render Global Group first
  renderEnvGroupCard('global', '全局公共配置 (Global Config)', loadedEnvGrouping.global || [], loadedEnvObject);
  
  // 2. Render each service group
  if (loadedEnvGrouping.services) {
    for (const [srvName, keys] of Object.entries(loadedEnvGrouping.services)) {
      renderEnvGroupCard(srvName, `${srvName} 服务专属变量`, keys || [], loadedEnvObject);
    }
  }
}

function renderEnvGroupCard(groupId, groupTitle, keys, envObj) {
  const container = document.getElementById('env-groups-container');
  
  const card = document.createElement('div');
  card.className = 'env-group-card';
  card.dataset.groupId = groupId;
  
  card.innerHTML = `
    <div class="env-group-header">
      <span class="env-group-title">${groupTitle}</span>
      <span class="badge badge-xs bg-secondary-soft">${keys.length} 个变量</span>
      <button type="button" class="btn btn-secondary btn-xs btn-add-group-var" style="margin-left:auto;">
        + 新增变量
      </button>
    </div>
    <div class="table-responsive">
      <table class="env-table">
        <thead>
          <tr>
            <th>变量名 (Key)</th>
            <th>变量值 (Value)</th>
            <th width="80">操作</th>
          </tr>
        </thead>
        <tbody>
          <!-- Rows -->
        </tbody>
      </table>
    </div>
  `;
  
  const tbody = card.querySelector('tbody');
  keys.forEach(key => {
    const val = envObj[key] || '';
    addEnvGroupTableRow(tbody, key, val);
  });
  
  // Add row button click listener
  const btnAdd = card.querySelector('.btn-add-group-var');
  btnAdd.addEventListener('click', () => {
    let keyPrefix = '';
    if (groupId !== 'global') {
      keyPrefix = groupId.toUpperCase().replace(/[^A-Z0-9]/g, '') + '_';
    }
    addEnvGroupTableRow(tbody, keyPrefix, '');
    
    // Update badge count
    const badge = card.querySelector('.badge');
    const count = tbody.querySelectorAll('tr').length;
    badge.textContent = `${count} 个变量`;
  });
  
  container.appendChild(card);
}

function addEnvGroupTableRow(tbody, key = '', val = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="env-key-input" value="${key}" placeholder="VARIABLE_NAME" required></td>
    <td><input type="text" class="env-val-input" value="${val}" placeholder="value"></td>
    <td>
      <button type="button" class="btn-icon-danger" onclick="this.closest('tr').remove(); updateEnvGroupCount(this);">&times;</button>
    </td>
  `;
  tbody.appendChild(tr);
}

window.updateEnvGroupCount = function(btn) {
  const card = btn.closest('.env-group-card');
  if (card) {
    const badge = card.querySelector('.badge');
    const count = card.querySelectorAll('tbody tr').length;
    badge.textContent = `${count} 个变量`;
  }
}

function syncVisualToRaw() {
  let content = '# ===================================================================================\n';
  content += '#                      DOCKER COMPOSE 环境变量配置文件 (.env)\n';
  content += '# ===================================================================================\n\n';
  
  const cards = document.querySelectorAll('.env-group-card');
  cards.forEach(card => {
    const groupTitle = card.querySelector('.env-group-title').textContent.trim();
    const rows = card.querySelectorAll('tbody tr');
    
    if (rows.length > 0) {
      content += `# -----------------------------------------------------------------------------------\n`;
      content += `# ${groupTitle}\n`;
      content += `# -----------------------------------------------------------------------------------\n`;
      
      rows.forEach(row => {
        const keyInput = row.querySelector('.env-key-input');
        const valInput = row.querySelector('.env-val-input');
        if (keyInput && valInput) {
          const key = keyInput.value.trim();
          const val = valInput.value.trim();
          if (key) {
            content += `${key}=${val}\n`;
          }
        }
      });
      content += `\n`;
    }
  });
  
  envRawTextarea.value = content.trim() + '\n';
}

async function handleSaveEnvSubmit() {
  let payload = {};
  
  if (envModeVisual.classList.contains('active')) {
    syncVisualToRaw();
  }
  
  payload.rawContent = envRawTextarea.value;

  try {
    const res = await fetch('/api/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    showAlert('环境变量配置文件 (.env) 已成功保存！');
    
    // Reload system variables and update visual panels
    await loadSystemStatus();
    await loadEnvFile();
    loadServices();
  } catch (err) {
    showAlert(`保存配置失败: ${err.message}`, 'error');
  }
}

// ===================================================================================
//                        自定义常用 Docker 命令行管理逻辑
// ===================================================================================
let customCommandsList = [];

async function loadCustomCommands() {
  try {
    const res = await fetch('/api/terminal/commands');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    customCommandsList = data;
    renderCustomCommands();
  } catch (err) {
    console.error('Failed to load custom commands:', err);
  }
}

function renderCustomCommands() {
  const container = document.getElementById('quick-cmds-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (customCommandsList.length === 0) {
    container.innerHTML = '<span class="text-muted text-sm">暂无自定义快捷命令</span>';
    return;
  }
  
  customCommandsList.forEach(cmdObj => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-xs q-cmd';
    btn.dataset.cmd = cmdObj.cmd;
    btn.textContent = cmdObj.name;
    
    // Bind click event dynamically
    btn.addEventListener('click', () => {
      const input = document.getElementById('terminal-cmd-input');
      const form = document.getElementById('form-terminal-cmd');
      if (input && form) {
        input.value = cmdObj.cmd;
        form.dispatchEvent(new Event('submit'));
      }
    });
    
    container.appendChild(btn);
  });
}

function openManageCommandsModal() {
  const modal = document.getElementById('modal-custom-commands');
  const tbody = document.getElementById('custom-cmds-tbody');
  tbody.innerHTML = '';
  
  customCommandsList.forEach(cmdObj => {
    addCommandTableRow(cmdObj.name, cmdObj.cmd);
  });
  
  openModal(modal);
}

function addCommandTableRow(name = '', cmd = '') {
  const tbody = document.getElementById('custom-cmds-tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="cmd-name-input" value="${name}" placeholder="如: 状态监控" style="width:100%; padding: 6px 10px;"></td>
    <td><input type="text" class="cmd-val-input" value="${cmd}" placeholder="如: docker stats --no-stream" style="width:100%; font-family:var(--font-mono); padding: 6px 10px;"></td>
    <td>
      <button type="button" class="btn-icon-danger" onclick="this.closest('tr').remove()">&times;</button>
    </td>
  `;
  tbody.appendChild(tr);
}

async function saveCustomCommands() {
  const tbody = document.getElementById('custom-cmds-tbody');
  const rows = tbody.querySelectorAll('tr');
  const commands = [];
  
  let valid = true;
  for (const row of rows) {
    const name = row.querySelector('.cmd-name-input').value.trim();
    const cmd = row.querySelector('.cmd-val-input').value.trim();
    if (name || cmd) {
      if (!cmd.startsWith('docker')) {
        showAlert(`命令内容必须以 "docker" 开头！错误命令: "${cmd}"`, 'error');
        valid = false;
        break;
      }
      if (!name) {
        showAlert('按钮名称不能为空！', 'error');
        valid = false;
        break;
      }
      commands.push({ name, cmd });
    }
  }
  
  if (!valid) return;
  
  try {
    const res = await fetch('/api/terminal/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    showAlert('自定义 Docker 命令快捷键已成功保存！');
    closeModal(document.getElementById('modal-custom-commands'));
    
    // Reload
    await loadCustomCommands();
  } catch (err) {
    showAlert(`保存命令失败: ${err.message}`, 'error');
  }
}

function parseBulkEnv(text) {
  text = text.trim();
  if (!text) return {};

  // Try parsing as JSON first
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result = {};
      for (const [k, v] of Object.entries(parsed)) {
        result[k.trim()] = String(v).trim();
      }
      return result;
    }
  } catch (e) {
    // Not JSON
  }

  // Fallback: Parse line-by-line or alternating
  const result = {};
  const lines = text.split('\n');
  
  // Detect Vercel alternating copy format
  let isVercelAlternating = false;
  if (lines.length >= 2 && lines.length % 2 === 0) {
    const hasEquals = lines.some(l => l.includes('=') || l.includes(':'));
    if (!hasEquals) {
      isVercelAlternating = true;
    }
  }

  if (isVercelAlternating) {
    for (let i = 0; i < lines.length; i += 2) {
      const key = lines[i].trim();
      const val = lines[i + 1].trim();
      if (key) {
        result[key] = val;
      }
    }
    return result;
  }

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    let idx = trimmed.indexOf('=');
    if (idx === -1) {
      idx = trimmed.indexOf(':');
    }
    if (idx === -1) {
      const key = trimmed.replace(/["';]/g, '').trim();
      if (key) result[key] = '';
      return;
    }

    let key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();

    key = key.replace(/^["']|["']$/g, '').trim();
    val = val.replace(/^["']|["']$/g, '').replace(/;$/, '').trim();

    if (key) {
      result[key] = val;
    }
  });

  return result;
}
