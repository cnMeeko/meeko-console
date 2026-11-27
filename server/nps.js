'use strict';

// NPS 内网穿透服务端集成（ehang-io/nps 0.26.x）
// NPS 把客户端与隧道持久化在 conf/clients.json、conf/tasks.json 中，
// 记录之间用 *#* 分隔；其运行时数据在内存里，改动文件后需要重启进程才生效。

const fs = require('fs');
const os = require('os');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || '/console-data';
const NPS_DIR = path.join(DATA_DIR, 'nps');
const CONF_DIR = path.join(NPS_DIR, 'conf');
const CONF_FILE = path.join(CONF_DIR, 'nps.conf');
const CLIENTS_FILE = path.join(CONF_DIR, 'clients.json');
const TASKS_FILE = path.join(CONF_DIR, 'tasks.json');
const HOSTS_FILE = path.join(CONF_DIR, 'hosts.json');
const PANEL_FILE = path.join(NPS_DIR, 'panel.json');

const NPS_BIN = process.env.NPS_BIN || '/opt/nps/nps';
const NPS_VERSION = process.env.NPS_VERSION || '0.26.10';
const DEFAULT_BRIDGE_PORT = Number(process.env.NPS_BRIDGE_PORT || 8024);
const WEB_PORT = Number(process.env.NPS_WEB_PORT || 18080);

const SEP = '*#*';

let proc = null;
let startedAt = 0;
let logs = [];
let manualStop = false;
let restartTimer = null;
const partial = { stdout: '', stderr: '' };
let queue = Promise.resolve();

/* --------------------------- 基础工具 --------------------------- */

function readPanel() {
  const defaults = { enabled: true, bridgePort: DEFAULT_BRIDGE_PORT, publicAddr: '' };
  try {
    const raw = JSON.parse(fs.readFileSync(PANEL_FILE, 'utf8'));
    return Object.assign(defaults, raw || {});
  } catch (e) {
    return defaults;
  }
}

function writePanel(cfg) {
  fs.mkdirSync(NPS_DIR, { recursive: true });
  fs.writeFileSync(PANEL_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/* ----------------------- 服务器公网地址自动识别 ----------------------- */
// 面板里「公网地址」留空时，用本机实际地址（先网卡，再外网探测）作为默认值，
// 避免出现写死示例、也不用手动填。可用 NPS_PUBLIC_ADDR / MEEKO_PUBLIC_ADDR 覆盖。

const ADDR_CACHE = path.join(NPS_DIR, 'server-addr.txt');
let detectedAddr = '';
let addrProbed = false;

function isPrivateIPv4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(function (n) { return !(n >= 0 && n <= 255); })) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 169 && p[1] === 254);
}

function localPublicIPv4() {
  const nics = os.networkInterfaces();
  let found = '';
  Object.keys(nics).forEach(function (name) {
    (nics[name] || []).forEach(function (n) {
      if (!found && n.family === 'IPv4' && !n.internal && !isPrivateIPv4(n.address)) found = n.address;
    });
  });
  return found;
}

function cachedAddr() {
  try { return fs.readFileSync(ADDR_CACHE, 'utf8').trim(); } catch (e) { return ''; }
}

function saveAddrCache(ip) {
  try {
    fs.mkdirSync(NPS_DIR, { recursive: true });
    fs.writeFileSync(ADDR_CACHE, ip, { mode: 0o600 });
  } catch (e) {}
}

function httpsText(url, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (v) { if (!done) { done = true; resolve(v); } };
    try {
      const req = https.get(url, { timeout: timeoutMs || 3000, headers: { 'User-Agent': 'meeko-console' } }, function (res) {
        let body = '';
        res.on('data', function (c) { if (body.length < 200) body += c; });
        res.on('end', function () { finish(String(body || '').trim()); });
      });
      req.on('timeout', function () { req.destroy(); finish(''); });
      req.on('error', function () { finish(''); });
    } catch (e) { finish(''); }
  });
}

async function probePublicAddrAsync() {
  const candidates = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://ipv4.icanhazip.com'];
  for (let i = 0; i < candidates.length; i++) {
    const text = await httpsText(candidates[i], 3000);
    const m = text.match(/^([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/);
    if (m && !isPrivateIPv4(m[1])) {
      detectedAddr = m[1];
      saveAddrCache(m[1]);
      return detectedAddr;
    }
  }
  return detectedAddr;
}

function probePublicAddr() {
  const env = String(process.env.NPS_PUBLIC_ADDR || process.env.MEEKO_PUBLIC_ADDR || '').trim();
  if (env) { detectedAddr = env; return detectedAddr; }
  detectedAddr = cachedAddr() || localPublicIPv4();
  if (!addrProbed) {
    addrProbed = true;
    probePublicAddrAsync().catch(function () {});
  }
  return detectedAddr;
}

function effectiveAddr(panel) {
  const custom = String((panel && panel.publicAddr) || '').trim();
  if (custom) return custom;
  return detectedAddr || probePublicAddr();
}

function readRecords(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [];
  }
  return text.split(SEP).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }).filter(Boolean);
}

function writeRecords(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // NPS 的记录格式：每条 JSON 一行，记录之间单独一行 *#*，文件以 *#* 结尾
  const body = list.length
    ? list.map(function (o) { return JSON.stringify(o); }).join('\n' + SEP) + '\n' + SEP
    : '';
  fs.writeFileSync(file, body, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) {}
}

function readClients() { return readRecords(CLIENTS_FILE); }
function writeClients(list) { writeRecords(CLIENTS_FILE, list); }
function readTunnels() { return readRecords(TASKS_FILE); }
function writeTunnels(list) { writeRecords(TASKS_FILE, list); }

function nextId(list, field) {
  let max = 0;
  list.forEach(function (o) { const n = Number(o[field]); if (n > max) max = n; });
  return max + 1;
}

function randomKey(len) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/* --------------------------- 配置文件 --------------------------- */

function confTemplate(bridgePort) {
  return [
    'appname = nps',
    'runmode = pro',
    '',
    '# 由 Meeko 面板生成，请勿手工修改（改动会被覆盖）',
    'http_proxy_ip=0.0.0.0',
    'http_proxy_port=',
    'https_proxy_port=',
    'https_just_proxy=false',
    'https_default_cert_file=conf/server.pem',
    'https_default_key_file=conf/server.key',
    '',
    '##bridge',
    'bridge_type=tcp',
    'bridge_port=' + bridgePort,
    'bridge_ip=0.0.0.0',
    '',
    'public_vkey=' + randomKey(6),
    '',
    'log_level=7',
    '',
    '##web（仅供本机面板使用，不对外开放）',
    'web_host=a.o.com',
    'web_username=admin',
    'web_password=' + randomKey(10),
    'web_port = ' + WEB_PORT,
    'web_ip=127.0.0.1',
    'web_base_url=',
    'web_open_ssl=false',
    'web_cert_file=conf/server.pem',
    'web_key_file=conf/server.key',
    'auth_crypt_key =' + randomKey(16).padEnd(16, 'x').slice(0, 16),
    '',
    'allow_user_login=false',
    'allow_user_register=false',
    'allow_user_change_username=false',
    '',
    'allow_flow_limit=true',
    'allow_rate_limit=true',
    'allow_tunnel_num_limit=true',
    'allow_local_proxy=true',
    'allow_connection_num_limit=true',
    'allow_multi_ip=false',
    'system_info_display=false',
    '',
    'http_cache=false',
    'http_cache_length=100',
    'http_add_origin_header=false',
    ''
  ].join('\n');
}

function ensureConf() {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  if (!fs.existsSync(CLIENTS_FILE)) writeClients([]);
  if (!fs.existsSync(TASKS_FILE)) writeTunnels([]);
  if (!fs.existsSync(HOSTS_FILE)) writeRecords(HOSTS_FILE, []);
  const panel = readPanel();
  if (!fs.existsSync(CONF_FILE)) {
    fs.writeFileSync(CONF_FILE, confTemplate(panel.bridgePort), { mode: 0o600 });
    return;
  }
  // 已存在时只同步桥接端口与内部网页端口，保留 NPS 自己写入的其它段落
  try {
    let text = fs.readFileSync(CONF_FILE, 'utf8');
    const next = text
      .replace(/^bridge_port=.*$/m, 'bridge_port=' + panel.bridgePort)
      .replace(/^web_port\s?=.*$/m, 'web_port = ' + WEB_PORT)
      .replace(/^web_ip=.*$/m, 'web_ip=127.0.0.1');
    if (next !== text) {
      text = next;
      fs.writeFileSync(CONF_FILE, text, { mode: 0o600 });
    }
  } catch (e) {}
}

/* --------------------------- 进程管理 --------------------------- */

function log(line) {
  const text = String(line)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+$/, '');
  if (!text) return;
  logs.push(text);
  if (logs.length > 500) logs.shift();
  console.log('[nps] ' + text);
}

function isRunning() { return !!proc; }

function spawnNps() {
  return new Promise(function (resolve, reject) {
    if (!fs.existsSync(NPS_BIN)) {
      return reject(new Error('未找到 NPS 可执行文件：' + NPS_BIN));
    }
    ensureConf();
    const p = spawn(NPS_BIN, [], { cwd: NPS_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;

    ['stdout', 'stderr'].forEach(function (name) {
      p[name].on('data', function (chunk) {
        partial[name] += chunk.toString('utf8');
        const lines = partial[name].split(/\r?\n/);
        partial[name] = lines.pop();
        lines.forEach(log);
      });
    });

    p.once('spawn', function () {
      startedAt = Date.now();
      log('[console] 已启动 NPS 服务端 (pid ' + p.pid + ')');
      resolve();
    });

    p.once('error', function (e) {
      log('[console] 无法启动 NPS: ' + e.message);
      if (proc === p) { proc = null; startedAt = 0; }
      reject(new Error('无法启动 NPS: ' + e.message));
    });

    p.on('exit', function (code, signal) {
      if (proc === p) { proc = null; startedAt = 0; }
      log('[console] NPS 退出 code=' + code + ' signal=' + (signal || ''));
      if (!manualStop && readPanel().enabled) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(function () {
          spawnNps().catch(function (e) { log('[console] NPS 重启失败: ' + e.message); });
        }, 5000);
      }
    });
  });
}

function stopNps() {
  clearTimeout(restartTimer);
  const p = proc;
  if (!p) return Promise.resolve();
  manualStop = true;
  return new Promise(function (resolve) {
    p.once('exit', function () { resolve(); });
    p.kill('SIGTERM');
    setTimeout(function () { if (proc === p) p.kill('SIGKILL'); }, 5000);
    setTimeout(resolve, 6000);
  }).then(function () {
    manualStop = false;
    log('[console] NPS 已停止');
  });
}

function startNps() {
  if (proc) return Promise.resolve();
  logs = [];
  partial.stdout = '';
  partial.stderr = '';
  return spawnNps();
}

// 串行执行，避免并发操作同时读写文件或反复重启
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(function () {});
  return run;
}

// 停止 -> 改文件 -> 重新启动，保证 NPS 读到最新配置
function mutate(fn) {
  return enqueue(async function () {
    const panel = readPanel();
    manualStop = true;
    if (proc) {
      await stopNps();
      manualStop = true;
    }
    fn();
    ensureConf();
    if (panel.enabled) {
      await startNps();
      await new Promise(function (resolve) { setTimeout(resolve, 800); });
      // 等进程真正起来（spawn 成功但端口占用时 NPS 会自行退出）
      if (!proc) throw new Error('NPS 未能启动，请检查端口是否被占用：');
    }
    manualStop = false;
  });
}

/* --------------------------- 数据整理 --------------------------- */

function clientModel(input) {
  return {
    Cnf: {
      U: String(input.u || ''),
      P: String(input.p || ''),
      Compress: !!input.compress,
      Crypt: !!input.crypt
    },
    Id: 0,
    VerifyKey: '',
    Addr: '',
    Remark: '',
    Status: input.status !== false,
    IsConnect: false,
    RateLimit: Number(input.rateLimit || 0),
    Flow: { ExportFlow: 0, InletFlow: 0, FlowLimit: Number(input.flowLimit || 0) },
    Rate: { NowRate: 0 },
    NoStore: false,
    NoDisplay: false,
    MaxConn: Number(input.maxConn || 0),
    NowConn: 0,
    WebUserName: '',
    WebPassword: '',
    ConfigConnAllow: input.configConnAllow !== false,
    MaxTunnelNum: Number(input.maxTunnelNum || 0),
    Version: ''
  };
}

function tunnelModel(mode, client, input, id) {
  return {
    Id: id,
    Port: Number(input.port),
    ServerIp: String(input.serverIp || '0.0.0.0'),
    Mode: mode,
    Status: input.status !== false,
    RunStatus: false,
    Client: client,
    Ports: '',
    Flow: { ExportFlow: 0, InletFlow: 0, FlowLimit: Number(input.flowLimit || 0) },
    Password: String(input.password || ''),
    Remark: String(input.remark || ''),
    TargetAddr: '',
    NoStore: !!input.noStore,
    LocalPath: '',
    StripPre: '',
    Target: { TargetStr: String(input.target || ''), TargetArr: null, LocalProxy: false },
    MultiAccount: null,
    HealthCheckTimeout: 0,
    HealthMaxFail: 0,
    HealthCheckInterval: 0,
    HealthNextTime: '0001-01-01T00:00:00Z',
    HealthMap: null,
    HttpHealthUrl: '',
    HealthRemoveArr: null,
    HealthCheckType: '',
    HealthCheckTarget: ''
  };
}

function publicClient(c, tunnels) {
  const count = tunnels.filter(function (t) { return t.Client && Number(t.Client.Id) === Number(c.Id); }).length;
  return {
    id: Number(c.Id),
    remark: c.Remark || '',
    vkey: c.VerifyKey || '',
    maxConn: Number(c.MaxConn || 0),
    maxTunnelNum: Number(c.MaxTunnelNum || 0),
    flowLimit: Number((c.Flow && c.Flow.FlowLimit) || 0),
    status: c.Status !== false,
    tunnelCount: count,
    connected: !!c.IsConnect
  };
}

function publicTunnel(t) {
  return {
    id: Number(t.Id),
    mode: String(t.Mode || '').toLowerCase(),
    port: Number(t.Port || 0),
    serverIp: t.ServerIp || '0.0.0.0',
    target: (t.Target && t.Target.TargetStr) || '',
    remark: t.Remark || '',
    password: t.Password || '',
    clientId: t.Client ? Number(t.Client.Id) : 0,
    clientRemark: t.Client ? (t.Client.Remark || '') : '',
    status: t.Status !== false,
    noStore: !!t.NoStore
  };
}

function sortTunnels(tunnels, mode) {
  return tunnels
    .filter(function (t) { return String(t.Mode || '').toLowerCase() === mode; })
    .sort(function (a, b) { return Number(a.Id) - Number(b.Id); });
}

function tunnelModelList() {
  return readTunnels().filter(function (t) {
    const mode = String(t.Mode || '').toLowerCase();
    return mode === 'tcp' || mode === 'udp';
  });
}

/* --------------------------- 校验 --------------------------- */

function assertPort(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error((label || '端口') + '必须是 1-65535 的整数');
  return n;
}

function assertTarget(value) {
  const target = String(value || '').trim();
  if (!target) throw new Error('请填写目标地址');
  if (!/^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+|\d{1,3}(\.\d{1,3}){3}):\d{1,5}$/.test(target)) {
    throw new Error('目标地址格式应为 IP:端口 或 域名:端口，例如 127.0.0.1:22');
  }
  const port = Number(target.slice(target.lastIndexOf(':') + 1));
  if (!port || port > 65535) throw new Error('目标端口不正确');
  return target;
}

function assertMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (m !== 'tcp' && m !== 'udp') throw new Error('隧道类型只能是 tcp 或 udp');
  return m;
}

function assertServerIp(value) {
  const ip = String(value || '0.0.0.0').trim() || '0.0.0.0';
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error('监听 IP 格式不正确');
  return ip;
}

function portTaken(tunnels, mode, port, serverIp, excludeIds) {
  const skip = excludeIds || [];
  return tunnels.some(function (t) {
    if (skip.indexOf(Number(t.Id)) >= 0) return false;
    if (String(t.Mode || '').toLowerCase() !== mode) return false;
    if (Number(t.Port) !== Number(port)) return false;
    return String(t.ServerIp || '0.0.0.0') === serverIp;
  });
}

/* --------------------------- 对外操作 --------------------------- */

function state() {
  const panel = readPanel();
  const tunnels = tunnelModelList();
  const autoAddr = detectedAddr || localPublicIPv4();
  return {
    config: {
      enabled: panel.enabled !== false,
      bridgePort: Number(panel.bridgePort) || DEFAULT_BRIDGE_PORT,
      // 没手动配置时直接回本机识别到的地址，界面输入框即默认显示服务器 IP
      publicAddr: effectiveAddr(panel),
      autoAddr: autoAddr,
      addrCustom: !!String(panel.publicAddr || '').trim(),
      webPort: WEB_PORT,
      version: NPS_VERSION,
      dataDir: NPS_DIR
    },
    status: {
      running: !!proc,
      pid: proc ? proc.pid : 0,
      startedAt: startedAt || null,
      uptime: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0
    },
    clients: readClients()
      .sort(function (a, b) { return Number(a.Id) - Number(b.Id); })
      .map(function (c) { return publicClient(c, tunnels); }),
    tunnels: {
      tcp: sortTunnels(tunnels, 'tcp').map(publicTunnel),
      udp: sortTunnels(tunnels, 'udp').map(publicTunnel)
    },
    logs: logs.slice(-200)
  };
}

function saveConfig(body) {
  const panel = readPanel();
  const next = Object.assign({}, panel);
  if (body.bridgePort != null && body.bridgePort !== '') {
    next.bridgePort = assertPort(body.bridgePort, '桥接端口');
  }
  if (body.publicAddr != null) {
    const addr = String(body.publicAddr || '').trim();
    if (addr && !/^[a-zA-Z0-9._\-\[\]:]+$/.test(addr)) throw new Error('公网地址格式不正确');
    next.publicAddr = addr;
  }
  if (body.enabled != null) next.enabled = !!body.enabled;
  const changedPort = next.bridgePort !== panel.bridgePort;
  return mutate(function () {
    writePanel(next);
    if (changedPort) {
      // 桥接端口变化后清掉旧 conf 里的端口，交给 ensureConf 重写
      try {
        const text = fs.readFileSync(CONF_FILE, 'utf8');
        fs.writeFileSync(CONF_FILE, text.replace(/^bridge_port=.*$/m, 'bridge_port=' + next.bridgePort));
      } catch (e) {}
    }
  }).then(state);
}

function addClients(items) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) throw new Error('没有要添加的客户端');
  return mutate(function () {
    const clients = readClients();
    list.forEach(function (input) {
      const model = clientModel(input);
      model.Id = nextId(clients, 'Id');
      let vkey = String(input.vkey || '').trim();
      if (!vkey) vkey = randomKey(10);
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(vkey)) throw new Error('验证密钥只能包含字母数字和 _ -');
      if (clients.some(function (c) { return c.VerifyKey === vkey; })) throw new Error('验证密钥已存在：' + vkey);
      model.VerifyKey = vkey;
      model.Remark = String(input.remark || '').trim() || ('客户端 ' + model.Id);
      clients.push(model);
    });
    writeClients(clients);
  }).then(state);
}

function updateClient(body) {
  const id = Number(body.id);
  if (!id) throw new Error('缺少客户端 ID');
  return mutate(function () {
    const clients = readClients();
    const target = clients.filter(function (c) { return Number(c.Id) === id; })[0];
    if (!target) throw new Error('客户端不存在');
    if (body.remark != null) target.Remark = String(body.remark).trim() || target.Remark;
    if (body.vkey != null && String(body.vkey).trim()) {
      const vkey = String(body.vkey).trim();
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(vkey)) throw new Error('验证密钥只能包含字母数字和 _ -');
      if (clients.some(function (c) { return Number(c.Id) !== id && c.VerifyKey === vkey; })) {
        throw new Error('验证密钥已存在：' + vkey);
      }
      target.VerifyKey = vkey;
    }
    if (body.maxConn != null) target.MaxConn = Math.max(0, Number(body.maxConn) || 0);
    if (body.maxTunnelNum != null) target.MaxTunnelNum = Math.max(0, Number(body.maxTunnelNum) || 0);
    if (body.flowLimit != null) target.Flow = Object.assign({}, target.Flow || {}, { FlowLimit: Math.max(0, Number(body.flowLimit) || 0) });
    if (body.status != null) target.Status = !!body.status;
    writeClients(clients);
    // 隧道里内嵌了客户端对象，同步一份新的
    const tunnels = readTunnels();
    let touched = false;
    tunnels.forEach(function (t) {
      if (t.Client && Number(t.Client.Id) === id) { t.Client = JSON.parse(JSON.stringify(target)); touched = true; }
    });
    if (touched) writeTunnels(tunnels);
  }).then(state);
}

function deleteClient(id) {
  const num = Number(id);
  if (!num) throw new Error('缺少客户端 ID');
  return mutate(function () {
    const clients = readClients();
    if (!clients.some(function (c) { return Number(c.Id) === num; })) throw new Error('客户端不存在');
    writeClients(clients.filter(function (c) { return Number(c.Id) !== num; }));
    // 客户端删除后其隧道无法工作，一并清理
    writeTunnels(readTunnels().filter(function (t) { return !(t.Client && Number(t.Client.Id) === num); }));
  }).then(state);
}

function addTunnels(body) {
  const mode = assertMode(body.mode);
  const clientId = Number(body.clientId);
  if (!clientId) throw new Error('请选择客户端');
  const items = Array.isArray(body.items) && body.items.length ? body.items : [body];
  const panel = readPanel();
  const bridgePort = Number(panel.bridgePort) || DEFAULT_BRIDGE_PORT;
  const result = { added: 0, failed: [] };

  return mutate(function () {
    const clients = readClients();
    const client = clients.filter(function (c) { return Number(c.Id) === clientId; })[0];
    if (!client) throw new Error('客户端不存在');
    const tunnels = readTunnels();
    items.forEach(function (item, index) {
      try {
        const port = assertPort(item.port);
        const serverIp = assertServerIp(item.serverIp);
        const target = assertTarget(item.target);
        if (mode === 'tcp' && port === bridgePort) throw new Error('端口 ' + port + ' 已被 NPS 桥接端口占用');
        if (portTaken(tunnels, mode, port, serverIp)) throw new Error('端口 ' + port + ' 已被其它' + mode.toUpperCase() + '隧道占用');
        const model = tunnelModel(mode, JSON.parse(JSON.stringify(client)), {
          port: port,
          serverIp: serverIp,
          target: target,
          remark: item.remark,
          password: item.password,
          status: item.status,
          noStore: item.noStore
        }, nextId(tunnels, 'Id'));
        tunnels.push(model);
        result.added++;
      } catch (e) {
        result.failed.push({ index: index, port: item.port, target: item.target, message: e.message });
      }
    });
    if (result.added) writeTunnels(tunnels);
  }).then(function () {
    return { added: result.added, failed: result.failed, state: state() };
  });
}

function updateTunnels(body) {
  const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number).filter(Boolean);
  if (!ids.length) throw new Error('请先选择要修改的隧道');
  const patch = body.patch || body;
  const mode = patch.mode ? assertMode(patch.mode) : '';
  const panel = readPanel();
  const bridgePort = Number(panel.bridgePort) || DEFAULT_BRIDGE_PORT;

  return mutate(function () {
    const clients = readClients();
    const tunnels = readTunnels();
    let clientId = null;
    if (patch.clientId != null && patch.clientId !== '') {
      clientId = Number(patch.clientId);
      if (!clients.some(function (c) { return Number(c.Id) === clientId; })) throw new Error('客户端不存在');
    }
    const nextClient = clientId ? clients.filter(function (c) { return Number(c.Id) === clientId; })[0] : null;

    ids.forEach(function (id) {
      const t = tunnels.filter(function (x) { return Number(x.Id) === id; })[0];
      if (!t) return;
      const targetMode = mode || String(t.Mode || '').toLowerCase();
      if (patch.port != null && patch.port !== '') {
        const port = assertPort(patch.port);
        const serverIp = patch.serverIp != null && patch.serverIp !== '' ? assertServerIp(patch.serverIp) : String(t.ServerIp || '0.0.0.0');
        if (targetMode === 'tcp' && port === bridgePort) throw new Error('端口 ' + port + ' 已被 NPS 桥接端口占用');
        if (portTaken(tunnels, targetMode, port, serverIp, [id])) throw new Error('端口 ' + port + ' 已被其它隧道占用');
        t.Port = port;
      }
      if (patch.serverIp != null && patch.serverIp !== '') t.ServerIp = assertServerIp(patch.serverIp);
      if (patch.target != null && patch.target !== '') t.Target = Object.assign({}, t.Target || {}, { TargetStr: assertTarget(patch.target) });
      if (patch.remark != null && patch.remark !== '') t.Remark = String(patch.remark);
      if (patch.password != null) t.Password = String(patch.password);
      if (patch.status != null) t.Status = !!patch.status;
      if (patch.noStore != null) t.NoStore = !!patch.noStore;
      if (nextClient) t.Client = JSON.parse(JSON.stringify(nextClient));
      if (mode) t.Mode = mode;
    });
    writeTunnels(tunnels);
  }).then(state);
}

function deleteTunnels(ids) {
  const list = (Array.isArray(ids) ? ids : String(ids || '').split(/[,\s]+/)).map(Number).filter(Boolean);
  if (!list.length) throw new Error('请先选择要删除的隧道');
  return mutate(function () {
    const tunnels = readTunnels();
    const next = tunnels.filter(function (t) { return list.indexOf(Number(t.Id)) < 0; });
    if (next.length === tunnels.length) throw new Error('所选隧道不存在');
    writeTunnels(next);
  }).then(state);
}

// 给客户端的连接命令（npc 客户端）
function clientCommand(client, publicAddr) {
  const panel = readPanel();
  const addr = String(publicAddr || '').trim() || effectiveAddr(panel);
  const host = addr.indexOf(':') >= 0 ? addr : addr + ':' + (Number(panel.bridgePort) || DEFAULT_BRIDGE_PORT);
  return 'npc -server=' + host + ' -vkey=' + (client.vkey || '') + ' -type=tcp';
}

function bootStart() {
  probePublicAddr();
  ensureConf();
  if (!readPanel().enabled) return;
  return startNps().catch(function (e) { log('[console] NPS 启动失败: ' + e.message); });
}

module.exports = {
  state: state,
  saveConfig: saveConfig,
  addClients: addClients,
  updateClient: updateClient,
  deleteClient: deleteClient,
  addTunnels: addTunnels,
  updateTunnels: updateTunnels,
  deleteTunnels: deleteTunnels,
  clientCommand: clientCommand,
  start: startNps,
  stop: function () { return enqueue(stopNps); },
  restart: function () {
    return enqueue(async function () {
      manualStop = true;
      if (proc) await stopNps();
      manualStop = true;
      await startNps();
      manualStop = false;
    });
  },
  // 恢复备份后重新读取 NPS 数据（仅在启用时重启）
  reload: function () {
    if (!readPanel().enabled) return Promise.resolve();
    return module.exports.restart();
  },
  bootStart: bootStart,
  isRunning: isRunning,
  log: log,
  ensureConf: ensureConf
};
