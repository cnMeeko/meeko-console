'use strict';

// 备份与恢复：本地导入/导出 + 七牛云 Kodo（仅依赖 Node 内置模块）

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || '/console-data';
const CADDY_SNIPPET = process.env.CADDY_SNIPPET || '/etc/caddy/domains.caddy';
const QINIU_FILE = path.join(DATA_DIR, 'qiniu.json');
const BACKUP_VERSION = 1;

// 七牛云存储区域（来源：https://developer.qiniu.com/kodo/manual/1671/region-endpoint）
const REGIONS = {
  z0:               { label: '华东-浙江',       up: 'up-z0.qiniup.com',              rsf: 'rsf-z0.qiniuapi.com',              iovip: 'iovip-z0.qiniuio.com' },
  'cn-east-2':      { label: '华东-浙江2',      up: 'up-cn-east-2.qiniup.com',       rsf: 'rsf-cn-east-2.qiniuapi.com',       iovip: 'iovip-cn-east-2.qiniuio.com' },
  z1:               { label: '华北-河北',       up: 'up-z1.qiniup.com',              rsf: 'rsf-z1.qiniuapi.com',              iovip: 'iovip-z1.qiniuio.com' },
  z2:               { label: '华南-广东',       up: 'up-z2.qiniup.com',              rsf: 'rsf-z2.qiniuapi.com',              iovip: 'iovip-z2.qiniuio.com' },
  na0:              { label: '北美-洛杉矶',     up: 'up-na0.qiniup.com',             rsf: 'rsf-na0.qiniuapi.com',             iovip: 'iovip-na0.qiniuio.com' },
  as0:              { label: '亚太-新加坡',     up: 'up-as0.qiniup.com',             rsf: 'rsf-as0.qiniuapi.com',             iovip: 'iovip-as0.qiniuio.com' },
  'ap-southeast-2': { label: '亚太-河内',       up: 'up-ap-southeast-2.qiniup.com',  rsf: 'rsf-ap-southeast-2.qiniuapi.com',  iovip: 'iovip-ap-southeast-2.qiniuio.com' },
  'ap-southeast-3': { label: '亚太-胡志明',     up: 'up-ap-southeast-3.qiniup.com',  rsf: 'rsf-ap-southeast-3.qiniuapi.com',  iovip: 'iovip-ap-southeast-3.qiniuio.com' }
};
const DEFAULT_REGION = 'z0';

// 需要备份的控制台数据文件（相对 DATA_DIR）
const DATA_FILES = ['account.json', 'domains.json', 'ddns.json', 'qiniu.json'];
const ET_DIR_REL = 'easytier';

/* --------------------------- 七牛云签名 --------------------------- */

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmacSha1(key, text) {
  return crypto.createHmac('sha1', key).update(text, 'utf8').digest();
}

// 上传凭证
function uploadToken(accessKey, secretKey, bucket, key, ttl) {
  const putPolicy = {
    scope: bucket + ':' + key,
    deadline: Math.floor(Date.now() / 1000) + (ttl || 3600)
  };
  const encoded = base64url(JSON.stringify(putPolicy));
  const sign = base64url(hmacSha1(secretKey, encoded));
  return accessKey + ':' + sign + ':' + encoded;
}

// 管理凭证（用于 list 等接口）
function manageToken(accessKey, secretKey, pathWithQuery) {
  const sign = base64url(hmacSha1(secretKey, pathWithQuery + '\n'));
  return 'QBox ' + accessKey + ':' + sign;
}

// 私有空间下载地址
function privateUrl(accessKey, secretKey, domain, key, ttl) {
  const deadline = Math.floor(Date.now() / 1000) + (ttl || 3600);
  const base = 'http://' + domain.replace(/\/+$/, '') + '/' + encodeURIComponent(key).replace(/%2F/g, '/');
  const url = base + '?e=' + deadline;
  const sign = base64url(hmacSha1(secretKey, url));
  return url + '&token=' + accessKey + ':' + sign;
}

function httpsRequest(method, target, headers, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(target);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: method,
      headers: headers || {}
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(30000, function () { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* --------------------------- 七牛云配置 --------------------------- */

function readQiniuConfig() {
  try {
    return JSON.parse(fs.readFileSync(QINIU_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeQiniuConfig(cfg) {
  fs.writeFileSync(QINIU_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 6) return '******';
  return s.slice(0, 3) + '******' + s.slice(-3);
}

function publicQiniuConfig() {
  const c = readQiniuConfig();
  return {
    accessKey: c.accessKey ? maskSecret(c.accessKey) : '',
    secretKey: c.secretKey ? maskSecret(c.secretKey) : '',
    bucket: c.bucket || '',
    domain: c.domain || '',
    prefix: c.prefix || 'ssl-console-backup/',
    region: c.region || DEFAULT_REGION,
    regions: Object.keys(REGIONS).map(function (id) { return { id: id, label: REGIONS[id].label, iovip: REGIONS[id].iovip }; }),
    hasKey: !!c.accessKey && !!c.secretKey
  };
}

function saveQiniuConfig(input) {
  const prev = readQiniuConfig();
  // UI 展示的是掩码后的密钥；如果提交的仍是掩码，则保留原值
  function resolve(field, prevVal) {
    const v = String(input[field] || '').trim();
    if (!v || v.indexOf('******') >= 0) return prevVal || '';
    return v;
  }
  const region = String(input.region || '').trim() || prev.region || DEFAULT_REGION;
  if (!REGIONS[region]) throw new Error('不支持的存储区域：' + region);
  const cfg = {
    accessKey: resolve('accessKey', prev.accessKey),
    secretKey: resolve('secretKey', prev.secretKey),
    bucket: String(input.bucket || '').trim(),
    domain: String(input.domain || '').trim(),
    prefix: String(input.prefix || '').trim(),
    region: region
  };
  if (!cfg.bucket) throw new Error('请填写 Bucket 名称');
  if (!cfg.accessKey || !cfg.secretKey) throw new Error('请填写 AccessKey 和 SecretKey');
  if (cfg.prefix && !/^[A-Za-z0-9._\-\/]+$/.test(cfg.prefix)) throw new Error('前缀只能包含字母数字和 . _ - /');
  if (cfg.prefix && cfg.prefix.slice(-1) !== '/') cfg.prefix += '/';
  if (!cfg.prefix) cfg.prefix = 'ssl-console-backup/';
  writeQiniuConfig(cfg);
  return cfg;
}

/* --------------------------- 本地备份打包 --------------------------- */

// 收集需要备份的文件：[ { src: 绝对路径, name: 包内相对路径 } ]
function collectBackupFiles() {
  const items = [];
  DATA_FILES.forEach(function (name) {
    const src = path.join(DATA_DIR, name);
    if (fs.existsSync(src)) items.push({ src: src, name: 'data/' + name });
  });
  const etFile = path.join(DATA_DIR, ET_DIR_REL, 'config.json');
  if (fs.existsSync(etFile)) items.push({ src: etFile, name: 'data/' + ET_DIR_REL + '/config.json' });
  if (fs.existsSync(CADDY_SNIPPET)) items.push({ src: CADDY_SNIPPET, name: 'caddy/domains.caddy' });
  return items;
}

function createBackupBuffer() {
  const meta = { version: BACKUP_VERSION, createdAt: new Date().toISOString() };
  const items = collectBackupFiles();
  // 用临时目录构建 tar 内容，避免 tar 对不存在文件报错
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-backup-'));
  try {
    items.forEach(function (it) {
      const dest = path.join(tmp, it.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(it.src, dest);
    });
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 2));
    const args = ['-czf', '-', '-C', tmp, '.'];
    const r = spawnSync('tar', args, { maxBuffer: 50 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('打包失败: ' + (r.stderr ? r.stderr.toString() : '未知错误'));
    return r.stdout;
  } finally {
    rmrf(tmp);
  }
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {}
}

// 校验并恢复备份
function restoreBackupBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new Error('备份文件无效');
  // gzip magic: 1F 8B
  if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) throw new Error('备份文件不是有效的 gzip 压缩包');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-restore-'));
  try {
    const tarFile = path.join(tmp, 'backup.tar.gz');
    fs.writeFileSync(tarFile, buffer);
    const extractDir = path.join(tmp, 'out');
    fs.mkdirSync(extractDir, { recursive: true });
    const r = spawnSync('tar', ['-xzf', tarFile, '-C', extractDir], { maxBuffer: 20 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('解压失败: ' + (r.stderr ? r.stderr.toString() : '未知错误'));
    const metaPath = path.join(extractDir, 'meta.json');
    if (!fs.existsSync(metaPath)) throw new Error('备份文件缺少 meta.json，格式不正确');
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
    catch (e) { throw new Error('备份文件 meta.json 无法解析'); }

    const dataDir = path.join(extractDir, 'data');
    if (fs.existsSync(dataDir)) {
      copyDir(dataDir, DATA_DIR);
    }
    const snippet = path.join(extractDir, 'caddy', 'domains.caddy');
    if (fs.existsSync(snippet)) {
      fs.copyFileSync(snippet, CADDY_SNIPPET);
    }
    return { meta: meta, restoredFiles: listFiles(extractDir) };
  } finally {
    rmrf(tmp);
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  entries.forEach(function (e) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  });
}

function listFiles(dir, base) {
  base = base || '';
  const result = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) result.push.apply(result, listFiles(path.join(dir, e.name), rel));
    else result.push(rel);
  });
  return result;
}

function backupFileName() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return 'ssl-console-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.tar.gz';
}

/* --------------------------- 七牛云上传/列表/恢复 --------------------------- */

function multipartUpload(url, fields, fileBuffer, fileName) {
  const boundary = '----sslconsole' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  Object.keys(fields).forEach(function (k) {
    parts.push(Buffer.from('--' + boundary + '\r\n'));
    parts.push(Buffer.from('Content-Disposition: form-data; name="' + k + '"\r\n\r\n'));
    parts.push(Buffer.from(String(fields[k])));
    parts.push(Buffer.from('\r\n'));
  });
  parts.push(Buffer.from('--' + boundary + '\r\n'));
  parts.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="' + fileName + '"\r\n'));
  parts.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  return httpsRequest('POST', url, {
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': body.length
  }, body);
}

async function uploadToQiniu(buffer, key) {
  const cfg = readQiniuConfig();
  if (!cfg.accessKey || !cfg.secretKey || !cfg.bucket) throw new Error('请先配置七牛云 AccessKey / SecretKey / Bucket');
  const region = REGIONS[cfg.region || DEFAULT_REGION] || REGIONS[DEFAULT_REGION];
  const token = uploadToken(cfg.accessKey, cfg.secretKey, cfg.bucket, key, 3600);
  const r = await multipartUpload('https://' + region.up, { token: token, key: key }, buffer, key);
  let json = null;
  try { json = JSON.parse(r.body.toString('utf8')); } catch (e) {}
  if (r.status !== 200) {
    throw new Error('七牛云上传失败 HTTP ' + r.status + ': ' + (json && json.error || r.body.toString('utf8')));
  }
  return { key: key, size: buffer.length, result: json };
}

async function listQiniu() {
  const cfg = readQiniuConfig();
  if (!cfg.accessKey || !cfg.secretKey || !cfg.bucket) throw new Error('请先配置七牛云 AccessKey / SecretKey / Bucket');
  const region = REGIONS[cfg.region || DEFAULT_REGION] || REGIONS[DEFAULT_REGION];
  const qs = 'bucket=' + encodeURIComponent(cfg.bucket)
    + '&prefix=' + encodeURIComponent(cfg.prefix || '')
    + '&limit=100';
  const pathWithQuery = '/list?' + qs;
  const auth = manageToken(cfg.accessKey, cfg.secretKey, pathWithQuery);
  const r = await httpsRequest('GET', 'https://' + region.rsf + pathWithQuery, { Authorization: auth });
  let json = null;
  try { json = JSON.parse(r.body.toString('utf8')); } catch (e) {}
  if (r.status !== 200) {
    throw new Error('七牛云列表失败 HTTP ' + r.status + ': ' + (json && json.error || r.body.toString('utf8')));
  }
  const items = (json && json.items) || [];
  return items.map(function (it) {
    return {
      key: it.key,
      size: it.fsize || 0,
      putTime: it.putTime ? new Date(it.putTime / 10000).toISOString() : '',
      hash: it.hash || ''
    };
  }).sort(function (a, b) { return b.putTime.localeCompare(a.putTime); });
}

async function restoreFromQiniu(key) {
  const cfg = readQiniuConfig();
  if (!cfg.accessKey || !cfg.secretKey || !cfg.bucket) throw new Error('请先配置七牛云 AccessKey / SecretKey / Bucket');
  if (!cfg.domain) throw new Error('请先配置七牛云下载域名（Domain）');
  const url = privateUrl(cfg.accessKey, cfg.secretKey, cfg.domain, key, 3600);
  const r = await httpsRequest('GET', url, {});
  if (r.status !== 200) {
    throw new Error('七牛云下载失败 HTTP ' + r.status);
  }
  return restoreBackupBuffer(r.body);
}

module.exports = {
  createBackupBuffer: createBackupBuffer,
  restoreBackupBuffer: restoreBackupBuffer,
  backupFileName: backupFileName,
  publicQiniuConfig: publicQiniuConfig,
  saveQiniuConfig: saveQiniuConfig,
  uploadToQiniu: uploadToQiniu,
  listQiniu: listQiniu,
  restoreFromQiniu: restoreFromQiniu
};
