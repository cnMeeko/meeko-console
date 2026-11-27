'use strict';

// SSL 证书管理控制台独立后端（零依赖，仅使用 Node 内置模块）

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ddns = require('./ddns');
const backup = require('./backup');
const nps = require('./nps');

const PORT = Number(process.env.PORT || 9600);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || '/data';
const CADDY_DATA = process.env.CADDY_DATA || '/caddy-data';
const CADDY_SNIPPET = process.env.CADDY_SNIPPET || '/etc/caddy/domains.caddy';
const CADDYFILE = process.env.CADDYFILE || '/etc/caddy/Caddyfile';
const STATIC_DIR = process.env.STATIC_DIR || '/app/admin';
const INIT_USER = process.env.CONSOLE_USER || 'admin';
const INIT_PASS = process.env.CONSOLE_PASS || 'admin';

const API_PREFIX = '/api/ssl-console';
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;
// 镜像角色标识：本镜像自带 Caddy / EasyTier / NPS 服务端，是"装在服务器上"的版本
const EDITION = process.env.MEEKO_EDITION || 'server';
const VERSION = process.env.VERSION || '0.3.0';
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.json');
const DOMAINS_FILE = path.join(DATA_DIR, 'domains.json');

// token -> { username, expires }
const sessions = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------ 账号 ------------------------------ */

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function readAccount() {
  try {
    const acc = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    if (acc && acc.username && acc.salt && acc.hash) return acc;
  } catch (e) { /* 首次运行 */ }
  const salt = crypto.randomBytes(16).toString('hex');
  const acc = { username: INIT_USER, salt: salt, hash: hashPassword(INIT_PASS, salt) };
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2));
  return acc;
}

function checkPassword(acc, password) {
  const got = Buffer.from(hashPassword(password, acc.salt), 'hex');
  const want = Buffer.from(acc.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ------------------------------ 域名 ------------------------------ */

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function validDomain(domain) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain);
}

function validUpstream(upstream) {
  return upstream.length <= 200 && /^[a-z0-9._:\-\[\]\/]+$/i.test(upstream);
}

// host 网络模式下容器与宿主机共用回环地址，127.0.0.1 / localhost 直接就是宿主机本身，
// 不需要再改写；同时把历史配置里的 host.docker.internal（旧桥接模式写法）纠正回来
function normalizeUpstream(value) {
  const upstream = String(value || '').trim();
  if (!upstream) return '';
  const m = upstream.match(/^(?:https?:\/\/)?(127\.0\.0\.1|localhost|host\.docker\.internal|host-gateway)(:\d+)?(\/.*)?$/i);
  if (m) return '127.0.0.1' + (m[2] || '') + (m[3] || '');
  return upstream;
}

function readDomains() {
  try {
    const list = JSON.parse(fs.readFileSync(DOMAINS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function writeDomains(list) {
  fs.writeFileSync(DOMAINS_FILE, JSON.stringify(list, null, 2));
}

// 主配置文件里已有的站点域名（避免重复定义）
function reservedDomains() {
  const reserved = new Set();
  let text = '';
  try {
    text = fs.readFileSync(CADDYFILE, 'utf8');
  } catch (e) {
    return reserved;
  }
  text.split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([^\s#{][^\s{]*)\s*\{/);
    if (m && m[1].indexOf('.') > 0 && m[1].indexOf(':') < 0) reserved.add(m[1].toLowerCase());
  });
  return reserved;
}

function writeSnippet(list) {
  const lines = ['# 由 SSL 证书管理控制台自动生成，请勿手工修改', ''];
  list.forEach(function (item) {
    const remark = String(item.remark || '').replace(/\r?\n/g, ' ');
    lines.push('# ' + item.domain + (remark ? ' - ' + remark : ''));
    lines.push(item.domain + ' {');
    lines.push('\ttls {');
    lines.push('\t\tissuer acme {');
    lines.push('\t\t\tdisable_http_challenge');
    lines.push('\t\t}');
    lines.push('\t}');
    lines.push('\tencode gzip');
    lines.push(item.upstream ? '\treverse_proxy ' + normalizeUpstream(item.upstream) : '\trespond "It works" 200');
    lines.push('}');
    lines.push('');
  });
  fs.writeFileSync(CADDY_SNIPPET, lines.join('\n'));
}

function formatDate(date) {
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function certStatus(domain) {
  const base = path.join(CADDY_DATA, 'caddy', 'certificates');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base);
  } catch (e) {
    return { status: 'pending', notAfter: null, daysLeft: null };
  }
  let file = null;
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i].indexOf('acme') !== 0) continue;
    const candidate = path.join(base, dirs[i], domain, domain + '.crt');
    if (fs.existsSync(candidate)) { file = candidate; break; }
  }
  if (!file) return { status: 'pending', notAfter: null, daysLeft: null };
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(file));
    const expires = new Date(cert.validTo);
    const daysLeft = Math.ceil((expires.getTime() - Date.now()) / 86400000);
    return {
      status: daysLeft > 0 ? 'valid' : 'expired',
      notAfter: formatDate(expires),
      daysLeft: daysLeft
    };
  } catch (e) {
    return { status: 'error', notAfter: null, daysLeft: null };
  }
}

function decorate(item) {
  const st = certStatus(item.domain);
  return {
    domain: item.domain,
    remark: item.remark || '',
    upstream: item.upstream || '',
    status: st.status,
    notAfter: st.notAfter,
    daysLeft: st.daysLeft
  };
}

/* ------------------------------ HTTP ------------------------------ */

function send(res, code, data) {
  const body = JSON.stringify(data == null ? {} : data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 65536) {
        reject(new Error('请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('请求格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxSize) {
  maxSize = maxSize || 20 * 1024 * 1024;
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('文件过大（上限 ' + Math.floor(maxSize / 1024 / 1024) + 'MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function tokenFrom(req) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

function currentUser(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.username;
}

function domainPayload(body) {
  return {
    domain: normalizeDomain(body.domain),
    remark: String(body.remark || '').trim(),
    upstream: normalizeUpstream(body.upstream)
  };
}

async function handle(req, res, route, url) {
  if (route === '/health' && req.method === 'GET') return send(res, 200, { ok: true, edition: EDITION, version: VERSION });

  if (route === '/login' && req.method === 'POST') {
    const body = await readBody(req);
    const acc = readAccount();
    const username = String(body.username || '').trim();
    if (username !== acc.username || !checkPassword(acc, String(body.password || ''))) {
      return send(res, 401, { message: '用户名或密码错误' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { username: acc.username, expires: Date.now() + TOKEN_TTL });
    res.setHeader('Set-Cookie', 'ssl_console=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(TOKEN_TTL / 1000));
    return send(res, 200, { token: token, username: acc.username, edition: EDITION, version: VERSION });
  }

  const username = currentUser(req);
  if (!username) return send(res, 401, { message: '未登录或登录已失效' });

  if (route === '/logout' && req.method === 'POST') {
    sessions.delete(tokenFrom(req));
    res.setHeader('Set-Cookie', 'ssl_console=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  if (route === '/auth' && req.method === 'GET') {
    return send(res, 200, { username: username, edition: EDITION, version: VERSION });
  }

  if (route === '/ddns/providers' && req.method === 'GET') {
    return send(res, 200, { providers: ddns.providers(), interval: ddns.intervalSeconds });
  }

  if (route === '/ddns/config' && req.method === 'GET') {
    return send(res, 200, Object.assign({}, ddns.config(), { interval: ddns.intervalSeconds }));
  }

  if (route === '/ddns/config' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      ddns.save(body);
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
    return send(res, 200, Object.assign({}, ddns.config(), { interval: ddns.intervalSeconds }));
  }

  if (route === '/ddns/run' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      await ddns.runAll(typeof body.groupId === 'string' ? body.groupId : '');
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
    const cfg = ddns.config();
    return send(res, 200, { tasks: cfg.tasks, groups: cfg.groups });
  }

  if (route === '/ddns/logs' && req.method === 'GET') {
    return send(res, 200, { logs: ddns.getLogs() });
  }

  if (route === '/easytier' && req.method === 'GET') {
    return send(res, 200, etState());
  }

  if (route === '/easytier' && req.method === 'PUT') {
    const body = await readBody(req);
    const cfg = normalizeEt(body);
    const invalid = validateEt(cfg);
    if (invalid) return send(res, 400, { message: invalid });
    cfg.enabled = true;
    writeEtConfig(cfg);
    try {
      await startEt(cfg);
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
    return send(res, 200, etState());
  }

  if (route === '/easytier/action' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = readEtConfig();
    if (body.action === 'stop') {
      cfg.enabled = false;
      writeEtConfig(cfg);
      await stopEt();
    } else if (body.action === 'start' || body.action === 'restart') {
      const invalid = validateEt(cfg);
      if (invalid) return send(res, 400, { message: invalid });
      cfg.enabled = true;
      writeEtConfig(cfg);
      try {
        await startEt(cfg);
      } catch (e) {
        return send(res, 500, { message: e.message });
      }
    } else {
      return send(res, 400, { message: '未知操作' });
    }
    return send(res, 200, etState());
  }

  if (route === '/domains' && req.method === 'GET') {
    return send(res, 200, { domains: readDomains().map(decorate) });
  }

  if (route === '/domains' && req.method === 'POST') {
    const body = await readBody(req);
    const item = domainPayload(body);
    if (!validDomain(item.domain)) return send(res, 400, { message: '域名格式不正确' });
    if (item.upstream && !validUpstream(item.upstream)) return send(res, 400, { message: '反代地址格式不正确' });
    const list = readDomains();
    if (list.some(function (i) { return i.domain === item.domain; }) || reservedDomains().has(item.domain)) {
      return send(res, 400, { message: '该域名已存在' });
    }
    list.push(item);
    writeDomains(list);
    writeSnippet(list);
    return send(res, 200, { domains: list.map(decorate) });
  }

  if (route === '/domains' && req.method === 'PUT') {
    const body = await readBody(req);
    const item = domainPayload(body);
    if (!validDomain(item.domain)) return send(res, 400, { message: '域名格式不正确' });
    if (item.upstream && !validUpstream(item.upstream)) return send(res, 400, { message: '反代地址格式不正确' });
    const list = readDomains();
    const original = normalizeDomain(body.originalDomain);
    const index = list.findIndex(function (i) { return i.domain === original; });
    if (index < 0) return send(res, 404, { message: '域名不存在' });
    const duplicated = list.some(function (i, n) { return n !== index && i.domain === item.domain; });
    if (duplicated) return send(res, 400, { message: '该域名已存在' });
    if (item.domain !== original && reservedDomains().has(item.domain)) {
      return send(res, 400, { message: '该域名已被主配置占用' });
    }
    list[index] = item;
    writeDomains(list);
    writeSnippet(list);
    return send(res, 200, { domains: list.map(decorate) });
  }

  if (route === '/domains' && req.method === 'DELETE') {
    const domain = normalizeDomain(url.searchParams.get('domain'));
    if (!domain) return send(res, 400, { message: '缺少域名参数' });
    const list = readDomains();
    const next = list.filter(function (i) { return i.domain !== domain; });
    if (next.length === list.length) return send(res, 404, { message: '域名不存在' });
    writeDomains(next);
    writeSnippet(next);
    return send(res, 200, { domains: next.map(decorate) });
  }

  if (route === '/account' && req.method === 'PUT') {
    const body = await readBody(req);
    const acc = readAccount();
    if (!checkPassword(acc, String(body.currentPassword || ''))) {
      return send(res, 400, { message: '当前密码不正确' });
    }
    const nextUser = String(body.username || '').trim() || acc.username;
    const newPassword = String(body.newPassword || '');
    if (newPassword && newPassword.length < 4) return send(res, 400, { message: '新密码至少 4 位' });
    let next;
    if (newPassword) {
      const salt = crypto.randomBytes(16).toString('hex');
      next = { username: nextUser, salt: salt, hash: hashPassword(newPassword, salt) };
    } else {
      next = { username: nextUser, salt: acc.salt, hash: acc.hash };
    }
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(next, null, 2));
    sessions.clear();
    return send(res, 200, { username: nextUser });
  }

  /* ------------------------------ NPS ------------------------------ */

  if (route === '/nps' && req.method === 'GET') {
    return send(res, 200, nps.state());
  }

  if (route === '/nps/config' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      return send(res, 200, await nps.saveConfig(body));
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
  }

  if (route === '/nps/action' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      if (body.action === 'stop') {
        await nps.stop();
      } else if (body.action === 'start' || body.action === 'restart') {
        await nps.restart();
      } else {
        return send(res, 400, { message: '未知操作' });
      }
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
    return send(res, 200, nps.state());
  }

  if (route === '/nps/clients' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return send(res, 200, await nps.addClients(body.items || body));
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
  }

  if (route === '/nps/clients' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      return send(res, 200, await nps.updateClient(body));
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
  }

  if (route === '/nps/clients' && req.method === 'DELETE') {
    try {
      return send(res, 200, await nps.deleteClient(url.searchParams.get('id')));
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
  }

  if (route === '/nps/tunnels' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const r = await nps.addTunnels(body);
      return send(res, 200, r);
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
  }

  if (route === '/nps/tunnels' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      return send(res, 200, await nps.updateTunnels(body));
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
  }

  if (route === '/nps/tunnels' && req.method === 'DELETE') {
    try {
      return send(res, 200, await nps.deleteTunnels(url.searchParams.get('ids') || url.searchParams.get('id')));
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
  }

  /* ------------------------------ 备份 ------------------------------ */

  if (route === '/backup/config' && req.method === 'GET') {
    return send(res, 200, backup.publicQiniuConfig());
  }

  if (route === '/backup/config' && req.method === 'PUT') {
    const body = await readBody(req);
    try {
      backup.saveQiniuConfig(body);
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
    return send(res, 200, backup.publicQiniuConfig());
  }

  if (route === '/backup/export' && req.method === 'GET') {
    const buf = backup.createBackupBuffer();
    const name = backup.backupFileName();
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Content-Length': buf.length
    });
    return res.end(buf);
  }

  if (route === '/backup/import' && req.method === 'POST') {
    const buf = await readRawBody(req, 20 * 1024 * 1024);
    try {
      const result = backup.restoreBackupBuffer(buf);
      await nps.reload().catch(function () {});
      return send(res, 200, { meta: result.meta, restoredFiles: result.restoredFiles });
    } catch (e) {
      return send(res, 400, { message: e.message });
    }
  }

  if (route === '/backup/qiniu/upload' && req.method === 'POST') {
    try {
      const buf = backup.createBackupBuffer();
      const prefix = (backup.publicQiniuConfig().prefix) || 'ssl-console-backup/';
      const key = prefix + backup.backupFileName();
      const r = await backup.uploadToQiniu(buf, key);
      return send(res, 200, { key: r.key, size: r.size });
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
  }

  if (route === '/backup/qiniu/list' && req.method === 'GET') {
    try {
      const items = await backup.listQiniu();
      return send(res, 200, { items: items });
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
  }

  if (route === '/backup/qiniu/restore' && req.method === 'POST') {
    const body = await readBody(req);
    const key = String(body.key || '').trim();
    if (!key) return send(res, 400, { message: '缺少备份文件名' });
    try {
      const result = await backup.restoreFromQiniu(key);
      await nps.reload().catch(function () {});
      return send(res, 200, { meta: result.meta, restoredFiles: result.restoredFiles });
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
  }

  return send(res, 404, { message: '接口不存在' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const root = path.resolve(STATIC_DIR);
  const file = path.resolve(path.join(root, rel));
  if (file.indexOf(root + path.sep) !== 0 && file !== root) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ----------------------------- EasyTier ----------------------------- */

const ET_DIR = path.join(DATA_DIR, 'easytier');
const ET_CONFIG_FILE = path.join(ET_DIR, 'config.json');
const ET_DEFAULTS = {
  enabled: false,
  hostname: '',
  networkName: '',
  networkSecret: '',
  ipv4: '',
  listeners: '11010',
  peers: '',
  privateMode: true
};

let etProc = null;
let etStartedAt = 0;
let etLogs = [];
let etManualStop = false;
let etRestartTimer = null;
const etPartial = { stdout: '', stderr: '' };

function etLog(line) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  etLogs.push(text);
  if (etLogs.length > 500) etLogs.shift();
  console.log('[easytier] ' + text);
}

function readEtConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(ET_CONFIG_FILE, 'utf8'));
    return Object.assign({}, ET_DEFAULTS, raw);
  } catch (e) {
    return Object.assign({}, ET_DEFAULTS);
  }
}

function writeEtConfig(cfg) {
  fs.mkdirSync(ET_DIR, { recursive: true });
  fs.writeFileSync(ET_CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(ET_CONFIG_FILE, 0o600); } catch (e) {}
}

function normalizeEt(body) {
  return {
    hostname: String(body.hostname || '').trim().slice(0, 64),
    networkName: String(body.networkName || '').trim().slice(0, 64),
    networkSecret: String(body.networkSecret || '').trim().slice(0, 128),
    ipv4: String(body.ipv4 || '').trim(),
    listeners: String(body.listeners || '11010').trim(),
    peers: String(body.peers || '').trim(),
    privateMode: !!body.privateMode
  };
}

function validateEt(cfg) {
  if (!cfg.networkName) return '请填写网络名称';
  if (!cfg.networkSecret) return '请填写网络密码';
  if (cfg.ipv4 && !/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(cfg.ipv4)) return '虚拟 IP 格式不正确';
  const token = /^[a-zA-Z0-9:+._\-\/\[\]]+$/;
  const listeners = String(cfg.listeners).split(/[,\s]+/).filter(Boolean);
  if (listeners.length === 0) return '请填写监听地址';
  if (listeners.some(function (v) { return !token.test(v); })) return '监听地址格式不正确';
  const peers = String(cfg.peers || '').split(/[,\s]+/).filter(Boolean);
  if (peers.some(function (v) { return !token.test(v); })) return '对端地址格式不正确';
  return '';
}

function etArgs(cfg) {
  const args = [
    '--hostname', cfg.hostname || 'easytier-server',
    '--network-name', cfg.networkName,
    '--network-secret', cfg.networkSecret,
    '--private-mode', cfg.privateMode ? 'true' : 'false'
  ];
  if (cfg.ipv4) args.push('--ipv4', cfg.ipv4);
  String(cfg.listeners || '11010').split(/[,\s]+/).filter(Boolean).forEach(function (v) {
    args.push('-l', v);
  });
  String(cfg.peers || '').split(/[,\s]+/).filter(Boolean).forEach(function (v) {
    args.push('-p', v);
  });
  return args;
}

function etState() {
  const cfg = readEtConfig();
  return {
    config: cfg,
    status: {
      running: !!etProc,
      pid: etProc ? etProc.pid : 0,
      startedAt: etStartedAt || null,
      uptime: etStartedAt ? Math.floor((Date.now() - etStartedAt) / 1000) : 0
    },
    logs: etLogs.slice(-200)
  };
}

function spawnEt(cfg) {
  return new Promise(function (resolve, reject) {
    const proc = spawn('easytier-core', etArgs(cfg), { stdio: ['ignore', 'pipe', 'pipe'] });
    etProc = proc;

    ['stdout', 'stderr'].forEach(function (name) {
      proc[name].on('data', function (chunk) {
        etPartial[name] += chunk.toString('utf8');
        const lines = etPartial[name].split(/\r?\n/);
        etPartial[name] = lines.pop();
        lines.forEach(etLog);
      });
    });

    proc.once('spawn', function () {
      etStartedAt = Date.now();
      etLog('[console] 已启动 easytier-core (pid ' + proc.pid + ')');
      resolve();
    });

    proc.once('error', function (e) {
      etLog('[console] 无法启动 easytier-core: ' + e.message);
      if (etProc === proc) {
        etProc = null;
        etStartedAt = 0;
      }
      reject(new Error('无法启动 easytier-core: ' + e.message));
    });

    proc.on('exit', function (code, signal) {
      if (etProc === proc) {
        etProc = null;
        etStartedAt = 0;
      }
      etLog('[console] easytier-core 退出 code=' + code + ' signal=' + (signal || ''));
      if (!etManualStop && readEtConfig().enabled) {
        clearTimeout(etRestartTimer);
        etRestartTimer = setTimeout(function () {
          startEt(readEtConfig()).catch(function (e) { etLog('[console] 重启失败: ' + e.message); });
        }, 5000);
      }
    });
  });
}

async function stopEt() {
  clearTimeout(etRestartTimer);
  const proc = etProc;
  if (!proc) return;
  etManualStop = true;
  await new Promise(function (resolve) {
    proc.once('exit', function () { resolve(); });
    proc.kill('SIGTERM');
    setTimeout(function () { if (etProc === proc) proc.kill('SIGKILL'); }, 4000);
  });
  etManualStop = false;
  etLog('[console] easytier-core 已停止');
}

async function startEt(cfg) {
  if (etProc) await stopEt();
  if (!cfg.networkName || !cfg.networkSecret) throw new Error('请填写网络名称和网络密码');
  etLogs = [];
  etPartial.stdout = '';
  etPartial.stderr = '';
  await spawnEt(cfg);
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');

  let route = url.pathname;
  if (route.indexOf(API_PREFIX) === 0) {
    route = route.slice(API_PREFIX.length) || '/';
    return handle(req, res, route, url).catch(function (e) {
      send(res, 500, { message: e.message || '服务器内部错误' });
    });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, url);
  }
  return send(res, 404, { message: '接口不存在' });
});

// 启动时按已保存的域名重建一次 Caddy 片段，保证文件存在且内容一致
try {
  writeSnippet(readDomains());
} catch (e) {
  console.error('[console] 写入 Caddy 配置片段失败:', e.message);
}

readAccount();

const etBoot = readEtConfig();
if (etBoot.enabled) {
  setTimeout(function () {
    startEt(etBoot).catch(function (e) { etLog('[console] EasyTier 启动失败: ' + e.message); });
  }, 1200);
}

// 容器启动后开始 DDNS 定时检查
ddns.start();

// NPS 服务端：先生成配置，再拉起进程
nps.ensureConf();
setTimeout(function () {
  nps.bootStart().catch(function (e) {
    console.error('[console] NPS 启动失败:', e.message);
  });
}, 800);

server.listen(PORT, HOST, function () {
  console.log('[console] Meeko 面板服务已启动（' + EDITION + ' 版），监听 ' + HOST + ':' + PORT);
});
