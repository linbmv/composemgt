// State Management
let servicesState = [];
let systemStatus = {};
let currentTab = 'containers';
let containerFilter = 'all';
let containerSearch = '';
let activeLogService = null;
let activeLogInterval = null;
let logEventSource = null;
let currentDeploySource = 'image';
let isEditingService = false;
let editingServiceName = '';

const stripAnsi = (str) => {
  if (!str) return '';
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
};

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
const volumesList = document.getElementById('volumes-list');
const envList = document.getElementById('env-list');
const composePasteInput = document.getElementById('srv-compose-paste');
const modalAddServiceTitle = document.getElementById('modal-add-service-title');
const btnSubmitAddService = document.getElementById('btn-submit-add-service');

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
    } else if (tabName === 'settings') {
      pageTitle.textContent = '备份与系统设置';
      pageSubtitle.textContent = '导入、导出配置或设置 WebDAV 云端自动备份';
      btnAddContainer.classList.add('hidden');
      loadWebDavConfig();
      loadWebDavBackups();
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
  
  // Toggle deployment source (Image vs Build)
  currentDeploySource = 'image';
  const sourceToggles = document.querySelectorAll('.source-toggle');
  const groupSrvImage = document.getElementById('group-srv-image');
  const groupSrvBuild = document.getElementById('group-srv-build');
  const inputSrvImage = document.getElementById('srv-image');
  const inputSrvBuildContext = document.getElementById('srv-build-context');

  sourceToggles.forEach(btn => {
    btn.addEventListener('click', () => {
      sourceToggles.forEach(b => {
        b.classList.remove('btn-primary', 'active');
        b.classList.add('btn-secondary');
      });
      btn.classList.add('btn-primary', 'active');
      btn.classList.remove('btn-secondary');

      const source = btn.dataset.source;
      currentDeploySource = source;

      if (source === 'image') {
        groupSrvImage.classList.remove('hidden');
        groupSrvBuild.classList.add('hidden');
        inputSrvImage.setAttribute('required', 'true');
        inputSrvBuildContext.removeAttribute('required');
      } else {
        groupSrvImage.classList.add('hidden');
        groupSrvBuild.classList.remove('hidden');
        inputSrvImage.removeAttribute('required');
        inputSrvBuildContext.setAttribute('required', 'true');
      }
    });
  });

  btnAddContainer.addEventListener('click', () => {
    isEditingService = false;
    editingServiceName = '';
    modalAddServiceTitle.textContent = '新增容器服务';
    btnSubmitAddService.textContent = '提交创建';
    document.getElementById('srv-name').removeAttribute('readonly');
    formAddService.reset();
    if (composePasteInput) composePasteInput.value = '';
    
    // Reset network mode selector to default
    const srvNetModeInput = document.getElementById('srv-net-mode');
    if (srvNetModeInput) {
      srvNetModeInput.value = 'd_home';
      handleNetModeChange('d_home');
    }
    
    // Clear dynamic inputs and append one initial empty row
    volumesList.innerHTML = '';
    envList.innerHTML = '';
    addVolumeRow();
    addEnvRow();

    const imgToggleBtn = document.querySelector('.source-toggle[data-source="image"]');
    if (imgToggleBtn) imgToggleBtn.click();
    openModal(modalAddService);
  });

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
  // Bind dynamic fields adding buttons
  const btnAddVolumeSingle = document.getElementById('btn-add-volume-single');
  if (btnAddVolumeSingle) {
    btnAddVolumeSingle.addEventListener('click', () => addVolumeRow());
  }
  const btnAddEnvSingle = document.getElementById('btn-add-env-single');
  if (btnAddEnvSingle) {
    btnAddEnvSingle.addEventListener('click', () => addEnvRow());
  }

  // Auto-parse on paste for volumes list
  if (volumesList) {
    volumesList.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text && (text.includes('\n') || text.includes(':'))) {
        e.preventDefault();
        const parsed = parseBulkVolumes(text);
        if (parsed.length > 0) {
          // If the current row's inputs are empty, remove it
          const targetRow = e.target.closest('.dynamic-row');
          if (targetRow) {
            const inputs = targetRow.querySelectorAll('input');
            if (!inputs[0].value.trim() && !inputs[1].value.trim()) {
              targetRow.remove();
            }
          }
          parsed.forEach(item => {
            addVolumeRow(item.host, item.container);
          });
        }
      }
    });
  }

  // Auto-parse on paste for env list
  if (envList) {
    envList.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text && (text.includes('\n') || text.includes('=') || text.includes(':'))) {
        e.preventDefault();
        const parsed = parseBulkEnv(text);
        const keys = Object.keys(parsed);
        if (keys.length > 0) {
          // If the current row's inputs are empty, remove it
          const targetRow = e.target.closest('.dynamic-row');
          if (targetRow) {
            const inputs = targetRow.querySelectorAll('input');
            if (!inputs[0].value.trim() && !inputs[1].value.trim()) {
              targetRow.remove();
            }
          }
          keys.forEach(k => {
            addEnvRow(k, parsed[k]);
          });
        }
      }
    });
  }

  if (composePasteInput) {
    composePasteInput.addEventListener('paste', () => {
      setTimeout(() => applyPastedCompose(composePasteInput.value), 0);
    });
    composePasteInput.addEventListener('blur', () => {
      if (composePasteInput.value.trim()) {
        applyPastedCompose(composePasteInput.value);
      }
    });
  }

  // Submit Add Service Form
  formAddService.addEventListener('submit', handleAddServiceSubmit);

  // Network Mode Selector Change Listener
  const srvNetMode = document.getElementById('srv-net-mode');
  if (srvNetMode) {
    srvNetMode.addEventListener('change', (e) => {
      handleNetModeChange(e.target.value);
    });
  }

  // Close Alert
  alertClose.addEventListener('click', () => alertBanner.classList.add('hidden'));

  // Logs Modal Refresher
  btnRefreshLogs.addEventListener('click', () => {
    if (activeLogService) showLogsModal(activeLogService);
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
          terminalConsoleOutput.textContent += `⚠️ 错误: ${stripAnsi(data.error) || '执行命令失败'}\n`;
        } else {
          if (data.stderr) {
            terminalConsoleOutput.textContent += `⚠️ 警告:\n${stripAnsi(data.stderr)}\n`;
          }
          terminalConsoleOutput.textContent += stripAnsi(data.stdout) || '（命令已成功运行，无任何标准输出）\n';
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

  // Mobile Sidebar Toggle
  const sidebar = document.querySelector('.sidebar');
  const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');

  if (btnSidebarToggle && sidebar && sidebarBackdrop) {
    btnSidebarToggle.addEventListener('click', () => {
      sidebar.classList.add('open');
      sidebarBackdrop.classList.add('open');
    });

    sidebarBackdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      sidebarBackdrop.classList.remove('open');
    });

    // Also close sidebar when clicking a nav item on mobile
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          sidebar.classList.remove('open');
          sidebarBackdrop.classList.remove('open');
        }
      });
    });
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

// composemgt is the panel itself; it cannot rebuild/update itself from inside
// (that would kill the serving process). Clicking「更新面板」copies the host
// command to the clipboard so the user can run it on the host.
function showBaseUpdateHelp() {
  const wd = (systemStatus && systemStatus.workDir) || '<docker主目录>';
  const cmd = `cd ${wd} && git -C composemgt pull && docker compose up -d --force-recreate --build composemgt`;
  const show = (copied) => showAlert(
    (copied ? '✅ 更新命令已复制到剪贴板，请在主机粘贴执行：\n' : 'ℹ️ 面板自身请在主机执行：\n') + cmd
  );
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cmd).then(() => show(true)).catch(() => show(false));
  } else {
    show(false);
  }
}

// One-click background self-update: the backend launches an independent helper
// container that runs git pull + rebuild after this response returns, so the
// panel updates itself and comes back automatically.
async function triggerSelfUpdate() {
  if (!confirm('将在后台起一个独立容器执行「git pull + 重建面板」，期间面板会短暂中断（约 20-40 秒），完成后自动恢复。\n\n确认更新面板？')) return;
  try {
    const res = await fetch('/api/services/composemgt/self-update', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '启动更新失败');
    showAlert(data.message || '面板正在后台更新，请约 30 秒后刷新页面。');
    // 后台会重建面板：延迟自动刷新，等新容器起来
    setTimeout(() => location.reload(), 35000);
  } catch (err) {
    showAlert('后台自更新启动失败，请改用主机命令: ' + err.message, 'error');
    showBaseUpdateHelp(); // 兜底：把手动命令复制到剪贴板
  }
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

    if (!data.baseServiceReady) {
      showAlert(`基础服务配置异常: ${data.baseServiceError}`, 'error');
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
          ${service.name === (systemStatus?.baseServiceName || 'composemgt')
            ? `<span class="text-muted text-sm" title="composemgt 是管理面板自身，生命周期/更新请在主机执行">面板自身</span>`
            : (isRunning ?
            `<button class="btn btn-secondary btn-xs" onclick="triggerAction('${service.name}', 'stop')" title="停止服务">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect></svg>
              停止
            </button>
            <button class="btn btn-secondary btn-xs" onclick="triggerAction('${service.name}', 'restart')" title="快速重启：停止并重新启动同一个容器，不改动配置/镜像（改了配置请用「重建」）">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              重启
            </button>`
            :
            `<button class="btn btn-primary btn-xs" onclick="triggerAction('${service.name}', 'start')" title="启动服务">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              启动
            </button>`)
          }
        </div>
        <div class="action-right">
          <button class="btn btn-secondary btn-xs" onclick="showLogsModal('${service.name}')" title="查看容器日志">
            日志
          </button>
          ${service.name === (systemStatus?.baseServiceName || 'composemgt')
            ? `<button class="btn btn-primary btn-xs" onclick="triggerSelfUpdate()" title="一键后台更新面板：起一个独立临时容器执行 git pull + 重建，面板短暂中断后自动恢复">
                🔄 更新面板
              </button>`
            : `<button class="btn btn-secondary btn-xs" onclick="showEditModal('${service.name}')" title="编辑服务配置">
            编辑
          </button>
          ${service.deploySource === 'build'
            ? `<button class="btn btn-primary btn-xs" onclick="triggerAction('${service.name}', 'build-update')" title="本地构建型更新：在构建目录 git pull 拉取最新代码 → 重新构建镜像 → 重建容器">
                🔄 更新
              </button>`
            : `<button class="btn btn-primary btn-xs" onclick="triggerAction('${service.name}', 'pull')" title="镜像型更新：从镜像仓库拉取最新镜像 → 重建容器">
                🔄 更新
              </button>`
          }
          <button class="btn btn-secondary btn-xs" onclick="triggerAction('${service.name}', 'recreate')" title="${service.deploySource === 'build' ? '使用当前本地源码重新构建镜像并强制重建容器（不拉取新代码）' : '使用当前本地镜像强制重建容器（不拉取新镜像，适用于修改配置后应用变更）'}">
            重建
          </button>
          <button class="btn btn-danger btn-xs" onclick="showDeleteModal('${service.name}')" title="从编排中删除此服务">
            &times;
          </button>`
          }
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
    // Append new logs line (stripping ANSI escape codes)
    logsOutput.textContent += stripAnsi(event.data) + '\n';
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

function handleNetModeChange(mode) {
  const dHomeGroup = document.getElementById('group-srv-network-d-home');
  const hostTip = document.getElementById('group-srv-network-host-tip');
  const pubPortInput = document.getElementById('srv-pub-port');
  const tgtPortInput = document.getElementById('srv-tgt-port');
  const ipSuffixInput = document.getElementById('srv-ip-suffix');

  if (mode === 'host') {
    if (dHomeGroup) dHomeGroup.style.display = 'none';
    if (hostTip) hostTip.classList.remove('hidden');
    
    // Clear values
    if (pubPortInput) pubPortInput.value = '';
    if (tgtPortInput) tgtPortInput.value = '';
    if (ipSuffixInput) ipSuffixInput.value = '';
  } else {
    if (dHomeGroup) dHomeGroup.style.display = 'contents';
    if (hostTip) hostTip.classList.add('hidden');
  }
}

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

function splitVolumeMapping(volume) {
  const lastColonIdx = volume.lastIndexOf(':');
  if (lastColonIdx === -1) {
    return { host: volume, container: '' };
  }
  return {
    host: volume.substring(0, lastColonIdx),
    container: volume.substring(lastColonIdx + 1)
  };
}

async function applyPastedCompose(composeText) {
  const text = composeText.trim();
  if (!text) return;

  try {
    const res = await fetch('/api/compose/parse-service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compose: text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    document.getElementById('srv-name').value = data.name || '';

    const toggleBtn = document.querySelector(`.source-toggle[data-source="${data.deploySource || 'image'}"]`);
    if (toggleBtn) toggleBtn.click();
    document.getElementById('srv-image').value = data.image || '';
    document.getElementById('srv-build-context').value = data.buildContext || '';
    document.getElementById('srv-build-dockerfile').value = data.buildDockerfile || '';

    const netModeInput = document.getElementById('srv-net-mode');
    netModeInput.value = data.networkMode || 'd_home';
    handleNetModeChange(netModeInput.value);
    document.getElementById('srv-pub-port').value = data.publishedPort || '';
    document.getElementById('srv-tgt-port').value = data.targetPort || '';
    document.getElementById('srv-ip-suffix').value = data.ipSuffix || '';

    volumesList.innerHTML = '';
    if (data.volumes && data.volumes.length > 0) {
      data.volumes.forEach(volume => {
        const parts = splitVolumeMapping(volume);
        addVolumeRow(parts.host, parts.container);
      });
    } else {
      addVolumeRow();
    }

    envList.innerHTML = '';
    if (data.environment && Object.keys(data.environment).length > 0) {
      Object.entries(data.environment).forEach(([key, value]) => addEnvRow(key, value));
    } else {
      addEnvRow();
    }

    const notices = [];
    if (data.serviceCount > 1) notices.push(`检测到 ${data.serviceCount} 个服务，已填入第一个服务 ${data.selectedService}。`);
    if (data.unsupported?.extraPorts?.length > 0) notices.push('当前表单只支持一个端口映射，已填入第一个端口。');
    if (data.unsupported?.containerNameDiffers) notices.push('container_name 与服务 ID 不一致，提交后会按服务 ID 写入容器名。');
    if (data.unsupported?.publishedPortChanged) notices.push(`粘贴的外部端口已被占用，自动改为 ${data.publishedPort}。`);
    if (data.unsupported?.ipSuffixChanged) notices.push(`粘贴的静态 IP 已被占用，自动改为 .${data.ipSuffix}。`);
    showAlert(notices.length > 0 ? notices.join(' ') : '已从 compose.yml 配置自动填入表单。', notices.length > 0 ? 'info' : 'success');
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

async function handleAddServiceSubmit(e) {
  e.preventDefault();
  
  const deploySource = currentDeploySource || 'image';
  const name = document.getElementById('srv-name').value.trim();
  const image = deploySource === 'image' ? document.getElementById('srv-image').value.trim() : undefined;
  const buildContext = deploySource === 'build' ? document.getElementById('srv-build-context').value.trim() : undefined;
  const buildDockerfile = deploySource === 'build' ? document.getElementById('srv-build-dockerfile').value.trim() : undefined;
  
  const networkMode = document.getElementById('srv-net-mode').value;
  const publishedPort = document.getElementById('srv-pub-port').value;
  const targetPort = document.getElementById('srv-tgt-port').value;
  const ipSuffix = document.getElementById('srv-ip-suffix').value;

  // Compile volumes from visual list inputs
  const volumes = [];
  const volRows = volumesList.querySelectorAll('.dynamic-row');
  volRows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const host = inputs[0].value.trim();
    const container = inputs[1].value.trim();
    if (host && container) {
      volumes.push(`${host}:${container}`);
    } else if (host) {
      volumes.push(host);
    }
  });

  // Compile environment variables from visual list inputs
  const environment = {};
  const envRows = envList.querySelectorAll('.dynamic-row');
  envRows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const key = inputs[0].value.trim();
    const val = inputs[1].value.trim();
    if (key) {
      environment[key] = val;
    }
  });

  const payload = {
    name,
    deploySource,
    image,
    buildContext,
    buildDockerfile,
    networkMode,
    publishedPort: (publishedPort && networkMode !== 'host') ? parseInt(publishedPort) : undefined,
    targetPort: (targetPort && networkMode !== 'host') ? parseInt(targetPort) : undefined,
    ipSuffix: (ipSuffix && networkMode !== 'host') ? parseInt(ipSuffix) : undefined,
    environment,
    volumes,
    isEdit: isEditingService
  };

  try {
    const res = await fetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    if (isEditingService) {
      showAlert(`容器服务 "${name}" 配置已成功修改并写入 compose.yml！请点击卡片下方的「重建」按钮以应用新配置。`);
    } else {
      showAlert(`容器服务 "${name}" 创建并成功插入 compose.yml！`);
    }
    closeModal(modalAddService);
    
    // Reset form and clear dynamic rows
    formAddService.reset();
    volumesList.innerHTML = '';
    envList.innerHTML = '';
    
    loadServices();
  } catch (err) {
    showAlert(`${isEditingService ? '编辑' : '新增'}容器失败: ${err.message}`, 'error');
  }
}

function showEditModal(serviceName) {
  const service = servicesState.find(s => s.name === serviceName);
  if (!service) {
    showAlert('未找到该服务的数据', 'error');
    return;
  }

  isEditingService = true;
  editingServiceName = serviceName;

  // Set modal header & button text
  modalAddServiceTitle.textContent = `编辑容器服务 - ${serviceName}`;
  btnSubmitAddService.textContent = '保存修改';

  // Make name/ID field read-only
  const inputName = document.getElementById('srv-name');
  inputName.value = serviceName;
  inputName.setAttribute('readonly', 'true');

  // Set deploy source
  const deploySource = service.deploySource || 'image';
  const imgToggleBtn = document.querySelector(`.source-toggle[data-source="${deploySource}"]`);
  if (imgToggleBtn) imgToggleBtn.click();

  // Prefill image or build info
  if (deploySource === 'image') {
    document.getElementById('srv-image').value = service.image || '';
  } else {
    document.getElementById('srv-build-context').value = service.buildContext || '';
    document.getElementById('srv-build-dockerfile').value = service.buildDockerfile || '';
  }

  // Prefill ports
  if (service.ports && service.ports.length > 0) {
    document.getElementById('srv-pub-port').value = service.ports[0].published || '';
    document.getElementById('srv-tgt-port').value = service.ports[0].target || '';
  } else {
    document.getElementById('srv-pub-port').value = '';
    document.getElementById('srv-tgt-port').value = '';
  }

  // Prefill IP suffix
  document.getElementById('srv-ip-suffix').value = service.ipSuffix || '';

  // Prefill Network Mode
  const netMode = service.networkMode || 'd_home';
  const srvNetModeInput = document.getElementById('srv-net-mode');
  if (srvNetModeInput) {
    srvNetModeInput.value = netMode;
  }
  handleNetModeChange(netMode);

  // Prefill volumes list
  volumesList.innerHTML = '';
  if (service.volumes && service.volumes.length > 0) {
    service.volumes.forEach(volStr => {
      const parts = volStr.split(':');
      if (parts.length >= 2) {
        addVolumeRow(parts[0], parts.slice(1).join(':'));
      } else {
        addVolumeRow(volStr, '');
      }
    });
  } else {
    addVolumeRow();
  }

  // Prefill env vars list
  envList.innerHTML = '';
  if (service.environment && Object.keys(service.environment).length > 0) {
    Object.entries(service.environment).forEach(([k, v]) => {
      addEnvRow(k, v);
    });
  } else {
    addEnvRow();
  }

  openModal(modalAddService);
}

// Expose to window so onclick works
window.showEditModal = showEditModal;

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
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    // Remove YAML list prefix "- " if present
    if (trimmed.startsWith('-')) {
      trimmed = trimmed.substring(1).trim();
    }

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

function parseBulkVolumes(text) {
  const result = [];
  const lines = text.split('\n');
  lines.forEach(line => {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    
    if (trimmed.startsWith('-')) {
      trimmed = trimmed.substring(1).trim();
    }
    
    trimmed = trimmed.replace(/^["']|["']$/g, '').trim();
    
    const lastColonIdx = trimmed.lastIndexOf(':');
    if (lastColonIdx === -1) {
      if (trimmed) {
        result.push({ host: trimmed, container: '' });
      }
      return;
    }
    
    const host = trimmed.substring(0, lastColonIdx).trim();
    const container = trimmed.substring(lastColonIdx + 1).trim();
    if (host || container) {
      result.push({ host, container });
    }
  });
  return result;
}

// ===================================================================================
//                        Settings & WebDAV Backup Logic
// ===================================================================================

async function loadWebDavConfig() {
  try {
    const res = await fetch('/api/webdav/config');
    if (!res.ok) throw new Error('Failed to load WebDAV config');
    const config = await res.json();
    
    document.getElementById('webdav-url').value = config.url || '';
    document.getElementById('webdav-username').value = config.username || '';
    document.getElementById('webdav-password').value = config.password || '';
    document.getElementById('webdav-directory').value = config.directory || '/composemgt_backups';
    document.getElementById('webdav-auto-backup').checked = !!config.autoBackup;
  } catch (err) {
    console.error('loadWebDavConfig error:', err);
  }
}

async function loadWebDavBackups() {
  const tbody = document.getElementById('webdav-backups-tbody');
  if (!tbody) return;
  
  tbody.innerHTML = `
    <tr>
      <td colspan="4" class="text-center text-muted" style="padding: 30px; text-align: center;">
        <div class="spinner" style="margin: 0 auto 10px auto; width: 24px; height: 24px;"></div>
        正在拉取云端备份列表...
      </td>
    </tr>
  `;

  try {
    const res = await fetch('/api/webdav/backups');
    if (!res.ok) throw new Error(await res.text());
    const backups = await res.json();
    
    tbody.innerHTML = '';
    if (backups.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" class="text-center text-muted" style="padding: 30px; text-align: center;">
            云端文件夹中暂无任何备份文件。
          </td>
        </tr>
      `;
      return;
    }

    backups.forEach(b => {
      const tr = document.createElement('tr');
      const formattedSize = (b.size / 1024).toFixed(2) + ' KB';
      const formattedDate = new Date(b.date).toLocaleString();
      
      tr.innerHTML = `
        <td style="font-family: var(--font-mono); font-size: 0.85rem;">${b.filename}</td>
        <td>${formattedSize}</td>
        <td>${formattedDate}</td>
        <td style="text-align: right; padding-right: 24px;">
          <button class="btn btn-secondary btn-xs btn-restore-webdav" data-filename="${b.filename}" style="background-color: var(--primary-soft); color: var(--primary); border-color: rgba(36,150,237,0.2); padding: 4px 8px;">
            恢复配置
          </button>
        </td>
      `;
      
      // Bind restore event
      tr.querySelector('.btn-restore-webdav').addEventListener('click', () => {
        handleWebDavRestore(b.filename);
      });

      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center text-danger" style="padding: 30px; text-align: center;">
          拉取备份列表失败: ${err.message || '请先确认 WebDAV 已正确配置并保存'}
        </td>
      </tr>
    `;
  }
}

async function handleWebDavRestore(filename) {
  if (!confirm(`⚠️ 确定要从云端备份 [${filename}] 恢复配置吗？这将会覆盖您本地现有的 compose.yml、.env 和自定义命令配置！`)) {
    return;
  }

  try {
    const res = await fetch('/api/webdav/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showAlert('🎉 成功从 WebDAV 恢复配置！正在重新加载系统数据...');
    
    // Reload local dashboard states
    await loadSystemStatus();
    loadServices();
  } catch (err) {
    showAlert(`恢复配置失败: ${err.message}`, 'error');
  }
}

// Bind Settings tab event listeners
document.addEventListener('DOMContentLoaded', () => {
  const btnExportBackup = document.getElementById('btn-export-backup');
  const inputImportBackup = document.getElementById('input-import-backup');
  const btnWebDavTest = document.getElementById('btn-webdav-test');
  const formWebDavConfig = document.getElementById('form-webdav-config');
  const btnWebDavRefresh = document.getElementById('btn-webdav-refresh');

  if (btnExportBackup) {
    btnExportBackup.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/backup/export');
        if (!res.ok) throw new Error('导出失败');
        const data = await res.json();
        
        // Trigger file download in browser
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `composemgt_backup_${dateStr}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        showAlert('备份文件已成功导出并下载！');
      } catch (err) {
        showAlert(`导出备份失败: ${err.message}`, 'error');
      }
    });
  }

  if (inputImportBackup) {
    inputImportBackup.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const payload = JSON.parse(event.target.result);
          if (!payload.compose || !payload.env) {
            throw new Error('无效的备份文件结构！必须包含 compose 与 env。');
          }

          if (!confirm('⚠️ 警告：确定要导入该备份配置吗？这将会覆盖您本地现有的所有 compose.yml、.env 以及自定义快捷命令！')) {
            inputImportBackup.value = '';
            return;
          }

          const res = await fetch('/api/backup/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);

          showAlert('🎉 配置成功导入并已全部应用！');
          inputImportBackup.value = '';
          
          // Reload
          await loadSystemStatus();
          loadServices();
        } catch (err) {
          showAlert(`导入备份失败: ${err.message}`, 'error');
          inputImportBackup.value = '';
        }
      };
      reader.readAsText(file);
    });
  }

  if (btnWebDavTest) {
    btnWebDavTest.addEventListener('click', async () => {
      const url = document.getElementById('webdav-url').value.trim();
      const username = document.getElementById('webdav-username').value.trim();
      const password = document.getElementById('webdav-password').value.trim();
      const directory = document.getElementById('webdav-directory').value.trim();

      if (!url || !username || !password || !directory) {
        showAlert('请先填满所有的 WebDAV 配置项后再进行测试！', 'error');
        return;
      }

      btnWebDavTest.disabled = true;
      btnWebDavTest.textContent = '⚡ 正在连接...';

      try {
        const res = await fetch('/api/webdav/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, username, password, directory })
        });
        const data = await res.json();
        
        if (!res.ok) throw new Error(data.error);
        showAlert('✅ WebDAV 连接测试成功，且备份目录状态正常！');
      } catch (err) {
        showAlert(`WebDAV 连接失败: ${err.message}`, 'error');
      } finally {
        btnWebDavTest.disabled = false;
        btnWebDavTest.textContent = '⚡ 测试连接';
      }
    });
  }

  if (formWebDavConfig) {
    formWebDavConfig.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const url = document.getElementById('webdav-url').value.trim();
      const username = document.getElementById('webdav-username').value.trim();
      const password = document.getElementById('webdav-password').value.trim();
      const directory = document.getElementById('webdav-directory').value.trim();
      const autoBackup = document.getElementById('webdav-auto-backup').checked;

      try {
        // Save Config
        const saveRes = await fetch('/api/webdav/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, username, password, directory, autoBackup })
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveData.error);

        showAlert('💾 WebDAV 配置已成功保存！正在触发即时备份...');

        // Trigger Backup
        const backupRes = await fetch('/api/webdav/backup', { method: 'POST' });
        const backupData = await backupRes.json();
        if (!backupRes.ok) throw new Error(backupData.error);

        showAlert('🎉 WebDAV 云端备份完成！备份列表已更新。');
        loadWebDavBackups();
      } catch (err) {
        showAlert(`保存或备份失败: ${err.message}`, 'error');
      }
    });
  }

  if (btnWebDavRefresh) {
    btnWebDavRefresh.addEventListener('click', () => {
      loadWebDavBackups();
    });
  }
});
