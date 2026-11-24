'use strict';

// 轻量 DDNS：直接对接各家 DNS API，只依赖 Node 内置模块

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const net = require('net');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'ddns.json');
const INTERVAL = Math.max(30, Number(process.env.DDNS_INTERVAL || 300));

const PROVIDERS = {
  aliyun: {
    label: '阿里云',
    keyLabel: 'AccessKey ID',
    secretLabel: 'AccessKey Secret',
    keyHint: 'LTAI 开头',
    minTtl: 600, maxTtl: 86400, ttl: 600
  },
  tencent: {
    label: '腾讯云',
    keyLabel: 'SecretId',
    secretLabel: 'SecretKey',
    keyHint: 'AKID 开头',
    minTtl: 600, maxTtl: 86400, ttl: 600
  },
  cloudflare: {
    label: 'Cloudflare',
    keyLabel: 'API Token',
    secretLabel: '',
    keyHint: '在 Cloudflare「我的个人资料 - API 令牌」创建',
    needsSecret: false,
    minTtl: 60, maxTtl: 86400, ttl: 300
  },
  spaceship: {
    label: 'Spaceship',
    keyLabel: 'API Key',
    secretLabel: 'API Secret',
    keyHint: '在 Spaceship API Manager 创建',
    minTtl: 60, maxTtl: 3600, ttl: 600
  }
};

const IP_SOURCES = {
  A: [
    'https://api.ipify.org',
    'https://ipv4.icanhazip.com',
    'https://www.cloudflare.com/cdn-cgi/trace'
  ],
  AAAA: [
    'https://api6.ipify.org',
    'https://ipv6.icanhazip.com'
  ]
};

let logs = [];
const zoneCache = Object.create(null);
let timer = null;
let ticking = false;

/* ----------------------------- 日志与存储 ----------------------------- */

function stamp() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function log(line) {
  const text = '[' + stamp() + '] ' + line;
  logs.push(text);
  if (logs.length > 300) logs.shift();
  console.log('[ddns] ' + line);
}

function emptyState() {
  return { groups: [], status: {} };
}

function parseDomains(raw) {
  const lines = Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/);
  const out = [];
  lines.forEach(function (item) {
    let line = String(item == null ? '' : item).trim().toLowerCase();
    if (!line || line.charAt(0) === '#') return;
    line = line.replace(/\.$/, '');
    if (out.indexOf(line) < 0) out.push(line);
  });
  return out;
}

// 每行一个域名，支持 www:example.com 手动拆分；同一列表内的主域名会被自动识别
function resolveDomains(lines) {
  const list = parseDomains(lines);
  return list.map(function (line) {
    let rr;
    let root;
    const mark = line.indexOf(':');
    if (mark > 0) {
      rr = line.slice(0, mark).trim() || '@';
      root = line.slice(mark + 1).trim();
      return { rr: rr, root: root };
    }
    const parent = list.filter(function (d) {
      return d !== line && line.length > d.length && line.slice(-(d.length + 1)) === '.' + d;
    }).sort(function (a, b) { return b.length - a.length; })[0];
    if (parent) {
      root = parent;
      rr = line.slice(0, line.length - parent.length - 1);
    } else {
      const parts = line.split('.');
      if (parts.length <= 2) {
        root = line;
        rr = '@';
      } else {
        root = parts.slice(-2).join('.');
        rr = parts.slice(0, -2).join('.');
      }
    }
    return { rr: rr || '@', root: root };
  });
}

function taskKey(task) {
  return (task.groupId || task.provider) + '|' + task.type + '|' + task.root + '|' + task.rr;
}

function pickStatus(task) {
  return {
    lastIp: task.lastIp || '',
    lastAt: task.lastAt || '',
    lastOk: task.lastOk === true,
    lastError: task.lastError || '',
    lastAction: task.lastAction || ''
  };
}

function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = PROVIDERS[raw.provider] ? raw.provider : '';
  if (!provider) return null;
  const cred = raw.creds || raw.cred || {};
  return {
    id: String(raw.id || crypto.randomBytes(6).toString('hex')),
    provider: provider,
    creds: { key: String(cred.key || ''), secret: String(cred.secret || '') },
    ipv4: {
      address: String((raw.ipv4 && raw.ipv4.address) || '').trim(),
      domains: parseDomains(raw.ipv4 && raw.ipv4.domains)
    },
    ipv6: {
      address: String((raw.ipv6 && raw.ipv6.address) || '').trim(),
      domains: parseDomains(raw.ipv6 && raw.ipv6.domains)
    }
  };
}

// 兼容旧数据：单服务商表单、{ text, tasks }、任务数组（按服务商分组）
function normalizeState(data) {
  const state = emptyState();
  if (!data || typeof data !== 'object') return state;
  state.status = data.status && typeof data.status === 'object' ? data.status : {};

  if (Array.isArray(data.groups)) {
    data.groups.forEach(function (g) {
      const group = normalizeGroup(g);
      if (group) state.groups.push(group);
    });
    return state;
  }

  if (data.ipv4 || data.ipv6) {
    const cred = (data.creds && data.creds[data.provider]) || data.creds || {};
    const group = normalizeGroup({
      provider: data.provider,
      creds: cred,
      ipv4: data.ipv4,
      ipv6: data.ipv6
    });
    if (group) state.groups.push(group);
    return state;
  }

  if (data.provider && (data.root !== undefined || Array.isArray(data.hosts))) {
    const root = String(data.root || '').trim();
    const hosts = (Array.isArray(data.hosts) ? data.hosts : String(data.hosts || '').split(/\r?\n/))
      .map(function (v) { return String(v).trim().toLowerCase(); })
      .filter(Boolean);
    const domains = hosts.map(function (rr) {
      return rr === '@' ? root : rr + '.' + root;
    });
    const group = normalizeGroup({
      provider: data.provider,
      creds: (data.creds && data.creds[data.provider]) || data.creds || {},
      ipv4: data.type === 'A' ? { address: '', domains: domains } : { address: '', domains: [] },
      ipv6: data.type === 'AAAA' ? { address: data.ipv6 || '', domains: domains } : { address: '', domains: [] }
    });
    if (group) state.groups.push(group);
    return state;
  }

  const old = Array.isArray(data) ? data : (Array.isArray(data.tasks) ? data.tasks : []);
  const map = Object.create(null);
  old.forEach(function (t) {
    if (!t || !PROVIDERS[t.provider]) return;
    let group = map[t.provider];
    if (!group) {
      group = map[t.provider] = normalizeGroup({ provider: t.provider, creds: t.cred || {} });
      state.groups.push(group);
    }
    const rr = t.rr || '@';
    const record = rr === '@' ? t.root : rr + '.' + t.root;
    const section = t.type === 'AAAA' ? group.ipv6 : group.ipv4;
    if (section.domains.indexOf(record) < 0) section.domains.push(record);
    state.status[taskKey({ groupId: group.id, type: t.type, root: t.root, rr: rr })] = pickStatus(t);
  });
  return state;
}

function readState() {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) { /* 首次运行 */ }
  return normalizeState(data);
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (e) {}
  fs.renameSync(tmp, FILE);
}

/* ------------------------------- HTTP ------------------------------- */

function request(method, target, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    const u = new URL(target);
    const headers = Object.assign({
      'User-Agent': 'ssl-console-ddns/1.0',
      'Accept-Encoding': 'identity'
    }, options.headers || {});
    const body = options.body ? Buffer.from(options.body, 'utf8') : null;
    if (body) headers['Content-Length'] = body.length;

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: method,
      headers: headers
    }, function (res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json: json });
      });
    });
    req.setTimeout(15000, function () { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmacBuf(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest();
}

function snippet(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? text.slice(0, 160) + '…' : text;
}

/* ----------------------------- 公网 IP ----------------------------- */

async function fetchIp(type) {
  const sources = IP_SOURCES[type] || IP_SOURCES.A;
  const errors = [];
  for (let i = 0; i < sources.length; i++) {
    const url = sources[i];
    try {
      const r = await request('GET', url);
      if (r.status !== 200) {
        errors.push(url + ' HTTP ' + r.status);
        continue;
      }
      let text = String(r.body || '').trim();
      if (url.indexOf('cdn-cgi/trace') >= 0) {
        const m = text.match(/^ip=(.+)$/m);
        text = m ? m[1].trim() : '';
      }
      if (net.isIP(text) === (type === 'AAAA' ? 6 : 4)) return text;
      errors.push(url + ' 返回的不是有效地址');
    } catch (e) {
      errors.push(url + ' ' + e.message);
    }
  }
  throw new Error('获取公网 IP 失败：' + errors.join('；'));
}

/* ------------------------------ 阿里云 ------------------------------ */

// 阿里云 RPC 签名要求的转义方式
function pe(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function aliyunCall(action, params, cred) {
  const all = Object.assign({
    AccessKeyId: cred.key,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2015-01-09'
  }, params);

  const query = Object.keys(all).sort().map(function (k) {
    return pe(k) + '=' + pe(all[k]);
  }).join('&');
  const signature = crypto.createHmac('sha1', cred.secret + '&')
    .update('GET&%2F&' + pe(query))
    .digest('base64');

  const r = await request('GET', 'https://alidns.aliyuncs.com/?' + query + '&Signature=' + pe(signature));
  const data = r.json || {};
  if (r.status !== 200 || data.Code) {
    throw new Error('阿里云 ' + action + ' 失败：' + (data.Message || data.Code || ('HTTP ' + r.status)));
  }
  return data;
}

async function applyAliyun(task, ip) {
  const list = await aliyunCall('DescribeDomainRecords', {
    DomainName: task.root,
    Type: task.type,
    PageSize: 500
  }, task.cred);
  const records = (list.DomainRecords && list.DomainRecords.Record) || [];
  const hit = records.filter(function (r) {
    return r.RR === task.rr && r.Type === task.type;
  })[0];

  if (hit && hit.Value === ip) return { changed: false };
  if (hit) {
    await aliyunCall('UpdateDomainRecord', {
      RecordId: hit.RecordId,
      RR: task.rr,
      Type: task.type,
      Value: ip,
      TTL: task.ttl
    }, task.cred);
  } else {
    await aliyunCall('AddDomainRecord', {
      DomainName: task.root,
      RR: task.rr,
      Type: task.type,
      Value: ip,
      TTL: task.ttl
    }, task.cred);
  }
  return { changed: true };
}

/* ------------------------------ 腾讯云 ------------------------------ */

async function tencentCall(action, payload, cred) {
  const host = 'dnspod.tencentcloudapi.com';
  const service = 'dnspod';
  const version = '2021-03-23';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const contentType = 'application/json; charset=utf-8';

  const canonicalHeaders = 'content-type:' + contentType + '\n'
    + 'host:' + host + '\n'
    + 'x-tc-action:' + action.toLowerCase() + '\n';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + sha256hex(body);
  const scope = date + '/' + service + '/tc3_request';
  const stringToSign = 'TC3-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + sha256hex(canonicalRequest);

  const kDate = hmacBuf('TC3' + cred.secret, date);
  const kService = hmacBuf(kDate, service);
  const kSigning = hmacBuf(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const r = await request('POST', 'https://' + host, {
    headers: {
      'Authorization': 'TC3-HMAC-SHA256 Credential=' + cred.key + '/' + scope
        + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
      'Content-Type': contentType,
      'Host': host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version
    },
    body: body
  });

  const data = r.json || {};
  const resp = data.Response || {};
  if (resp.Error) {
    throw new Error('腾讯云 ' + action + ' 失败：' + resp.Error.Message + '（' + resp.Error.Code + '）');
  }
  if (r.status !== 200) {
    throw new Error('腾讯云 ' + action + ' 失败：HTTP ' + r.status + ' ' + snippet(r.body));
  }
  return resp;
}

async function applyTencent(task, ip) {
  const resp = await tencentCall('DescribeRecordList', {
    Domain: task.root,
    SubDomain: task.rr,
    RecordType: task.type,
    RecordLine: '默认',
    Limit: 100
  }, task.cred);
  const records = resp.RecordList || [];
  const hit = records.filter(function (r) {
    return r.Name === task.rr && r.Type === task.type;
  })[0];

  if (hit && hit.Value === ip) return { changed: false };
  if (hit) {
    await tencentCall('ModifyRecord', {
      Domain: task.root,
      RecordId: hit.RecordId,
      SubDomain: task.rr,
      RecordType: task.type,
      RecordLine: hit.Line || '默认',
      Value: ip,
      TTL: task.ttl
    }, task.cred);
  } else {
    await tencentCall('CreateRecord', {
      Domain: task.root,
      SubDomain: task.rr,
      RecordType: task.type,
      RecordLine: '默认',
      Value: ip,
      TTL: task.ttl
    }, task.cred);
  }
  return { changed: true };
}

/* ---------------------------- Cloudflare ---------------------------- */

async function cfCall(pathname, method, body, token) {
  const options = {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = body;
  const r = await request(method || 'GET', 'https://api.cloudflare.com/client/v4' + pathname, options);
  const data = r.json || {};
  if (r.status >= 400 || data.success === false) {
    const message = (data.errors && data.errors[0] && data.errors[0].message) || ('HTTP ' + r.status);
    throw new Error('Cloudflare 请求失败：' + message);
  }
  return data;
}

async function applyCloudflare(task, ip) {
  const token = task.cred.key;
  let zone = zoneCache[task.root];
  if (!zone) {
    const z = await cfCall('/zones?name=' + encodeURIComponent(task.root) + '&per_page=5', 'GET', null, token);
    if (!z.result || !z.result.length) {
      throw new Error('Cloudflare 找不到域名 ' + task.root + '，请确认该 Token 有该域名的 DNS 权限');
    }
    zone = z.result[0].id;
    zoneCache[task.root] = zone;
  }

  const fqdn = task.rr === '@' ? task.root : task.rr + '.' + task.root;
  const q = await cfCall('/zones/' + zone + '/dns_records?type=' + task.type
    + '&name=' + encodeURIComponent(fqdn) + '&per_page=1', 'GET', null, token);
  const hit = (q.result || [])[0];
  if (hit && hit.content === ip) return { changed: false };

  const payload = JSON.stringify({
    type: task.type,
    name: fqdn,
    content: ip,
    ttl: task.ttl,
    proxied: hit ? !!hit.proxied : false
  });
  if (hit) {
    await cfCall('/zones/' + zone + '/dns_records/' + hit.id, 'PATCH', payload, token);
  } else {
    await cfCall('/zones/' + zone + '/dns_records', 'POST', payload, token);
  }
  return { changed: true };
}

/* ----------------------------- Spaceship ----------------------------- */

function spaceshipError(r) {
  const data = r.json || {};
  const code = r.headers['spaceship-error-code'] || '';
  let detail = data.detail || '';
  if (Array.isArray(data.data) && data.data.length) {
    detail = data.data.map(function (d) {
      return (d.field ? d.field + ': ' : '') + (d.details || '');
    }).join('; ');
  }
  if (r.status === 401) detail = 'API Key 或 API Secret 不正确';
  if (r.status === 403) detail = 'API Key 缺少 DNS 读写权限';
  if (r.status === 404 && !detail) detail = '域名未在 Spaceship 托管';
  if (r.status === 429) detail = '请求过于频繁（300 次/300 秒）';
  return new Error('Spaceship 请求失败：HTTP ' + r.status
    + (code ? '（' + code + '）' : '')
    + (detail ? ' ' + detail : ''));
}

async function spaceshipRecords(task) {
  const items = [];
  let skip = 0;
  for (let page = 0; page < 10; page++) {
    const url = 'https://spaceship.dev/api/v1/dns/records/' + encodeURIComponent(task.root)
      + '?take=100&skip=' + skip;
    const r = await request('GET', url, {
      headers: {
        'X-Api-Key': task.cred.key,
        'X-Api-Secret': task.cred.secret,
        'Accept': 'application/json'
      }
    });
    if (r.status !== 200) throw spaceshipError(r);
    const list = (r.json && r.json.items) || [];
    items.push.apply(items, list);
    if (list.length < 100) break;
    skip += 100;
  }
  return items;
}

async function applySpaceship(task, ip) {
  const base = 'https://spaceship.dev/api/v1/dns/records/' + encodeURIComponent(task.root);
  const headers = {
    'X-Api-Key': task.cred.key,
    'X-Api-Secret': task.cred.secret,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  const items = await spaceshipRecords(task);
  const hit = items.filter(function (r) {
    return r.type === task.type && r.name === task.rr;
  })[0];

  if (hit && hit.address === ip) return { changed: false };
  if (hit) {
    const del = await request('DELETE', base, {
      headers: headers,
      body: JSON.stringify([{
        type: hit.type,
        name: hit.name,
        address: hit.address,
        ttl: hit.ttl || task.ttl
      }])
    });
    if (del.status !== 204) throw spaceshipError(del);
  }

  const put = await request('PUT', base, {
    headers: headers,
    body: JSON.stringify({
      force: true,
      items: [{ type: task.type, name: task.rr, address: ip, ttl: task.ttl }]
    })
  });
  if (put.status !== 204) throw spaceshipError(put);
  return { changed: true };
}

/* ------------------------------ 任务执行 ------------------------------ */

const APPLIERS = {
  aliyun: applyAliyun,
  tencent: applyTencent,
  cloudflare: applyCloudflare,
  spaceship: applySpaceship
};

async function runTask(task) {
  const record = task.rr === '@' ? task.root : task.rr + '.' + task.root;
  const applier = APPLIERS[task.provider];
  try {
    if (!applier) throw new Error('不支持的服务商');
    const ip = task.fixedIp || await fetchIp(task.type);
    const result = await applier(task, ip);
    task.lastIp = ip;
    task.lastOk = true;
    task.lastError = '';
    task.lastAction = result.changed ? '已更新为 ' + ip : '无需更新';
    log('[' + record + '] ' + task.lastAction);
  } catch (e) {
    task.lastOk = false;
    task.lastError = e.message || String(e);
    task.lastAction = '';
    log('[' + record + '] 失败：' + task.lastError);
  }
  task.lastAt = new Date().toISOString();
  return task;
}

function buildTasks(state) {
  const tasks = [];
  state.groups.forEach(function (group) {
    const meta = PROVIDERS[group.provider] || {};
    const cred = group.creds || {};
    [['ipv4', 'A'], ['ipv6', 'AAAA']].forEach(function (pair) {
      const section = group[pair[0]] || {};
      const type = pair[1];
      const fixedIp = String(section.address || '').trim();
      resolveDomains(section.domains || []).forEach(function (item) {
        tasks.push({
          groupId: group.id,
          provider: group.provider,
          root: item.root,
          rr: item.rr,
          type: type,
          ttl: meta.ttl,
          cred: { key: cred.key || '', secret: cred.secret || '' },
          fixedIp: fixedIp
        });
      });
    });
  });
  return tasks;
}

async function runAll(groupId) {
  const state = readState();
  const all = buildTasks(state);
  const tasks = groupId ? all.filter(function (t) { return t.groupId === groupId; }) : all;
  for (let i = 0; i < tasks.length; i++) {
    await runTask(tasks[i]);
    state.status[taskKey(tasks[i])] = pickStatus(tasks[i]);
  }
  const alive = Object.create(null);
  tasks.forEach(function (t) { alive[taskKey(t)] = true; });
  const groups = Object.create(null);
  (groupId ? state.groups.filter(function (g) { return g.id === groupId; }) : state.groups)
    .forEach(function (g) { groups[g.id] = true; });
  Object.keys(state.status).forEach(function (k) {
    const id = k.split('|')[0];
    if (groups[id] && !alive[k]) delete state.status[k];
  });
  writeState(state);
  return tasks;
}

function tick() {
  if (ticking) return;
  ticking = true;
  runAll().catch(function (e) {
    log('定时更新出错：' + e.message);
  }).then(function () { ticking = false; });
}

function start() {
  if (timer) return;
  setTimeout(tick, 3000);
  timer = setInterval(tick, INTERVAL * 1000);
  log('已启动，间隔 ' + INTERVAL + ' 秒');
}

/* ------------------------------ 对外接口 ------------------------------ */

function validDomain(domain) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain);
}

function validHost(host) {
  return /^(@|\*|[a-z0-9_](?:[a-z0-9_.-]{0,61}[a-z0-9_])?)$/.test(host);
}

function publicTask(task, status) {
  const meta = PROVIDERS[task.provider] || {};
  const s = status || {};
  return {
    provider: task.provider,
    providerLabel: meta.label || task.provider,
    root: task.root,
    rr: task.rr,
    record: task.rr === '@' ? task.root : task.rr + '.' + task.root,
    type: task.type,
    ttl: task.ttl,
    lastIp: s.lastIp || '',
    lastAt: s.lastAt || '',
    lastOk: s.lastOk === true,
    lastError: s.lastError || '',
    lastAction: s.lastAction || ''
  };
}

// 保存表单：多个服务商分组，每组密钥在上、IPv4/IPv6 地址与域名在下
function saveForm(input) {
  const prev = readState();
  const groups = [];
  const list = Array.isArray(input.groups) ? input.groups : [];

  list.forEach(function (raw, index) {
    if (!raw || typeof raw !== 'object') return;
    const label = '第 ' + (index + 1) + ' 个服务商：';
    const provider = String(raw.provider || '').trim();
    const meta = PROVIDERS[provider];
    if (!meta) throw new Error(label + '请选择支持的服务商');

    const ipv4Address = String((raw.ipv4 && raw.ipv4.address) || '').trim();
    const ipv6Address = String((raw.ipv6 && raw.ipv6.address) || '').trim();
    if (ipv4Address && net.isIP(ipv4Address) !== 4) throw new Error(label + 'IPv4 地址格式不正确');
    if (ipv6Address && net.isIP(ipv6Address) !== 6) throw new Error(label + 'IPv6 地址格式不正确');

    const ipv4Domains = parseDomains(raw.ipv4 && raw.ipv4.domains);
    const ipv6Domains = parseDomains(raw.ipv6 && raw.ipv6.domains);
    const bad = [];
    resolveDomains(ipv4Domains).concat(resolveDomains(ipv6Domains)).forEach(function (d) {
      if (!validDomain(d.root)) bad.push(d.root || '(空域名)');
      if (!validHost(d.rr)) bad.push(d.rr);
    });
    if (bad.length) throw new Error(label + '域名格式不正确：' + bad.join('、'));
    if (!ipv4Domains.length && !ipv6Domains.length) return;

    const prevGroup = raw.id ? prev.groups.filter(function (g) { return g.id === raw.id; })[0] : null;
    const oldCred = (prevGroup && prevGroup.creds) || {};
    const key = String(raw.key || '').trim() || oldCred.key || '';
    const secret = meta.needsSecret === false
      ? ''
      : (String(raw.secret || '').trim() || oldCred.secret || '');
    if (!key) throw new Error(label + '请填写 ' + meta.keyLabel);
    if (meta.needsSecret !== false && !secret) throw new Error(label + '请填写 ' + meta.secretLabel);

    groups.push({
      id: String(raw.id || '') || crypto.randomBytes(6).toString('hex'),
      provider: provider,
      creds: { key: key, secret: secret },
      ipv4: { address: ipv4Address, domains: ipv4Domains },
      ipv6: { address: ipv6Address, domains: ipv6Domains }
    });
  });

  if (!groups.length) throw new Error('请至少填写一个域名');

  const state = { groups: groups, status: prev.status };
  writeState(state);
  return state;
}

function config() {
  const state = readState();
  return {
    groups: state.groups.map(function (g) {
      return {
        id: g.id,
        provider: g.provider,
        key: g.creds.key || '',
        secret: g.creds.secret || '',
        ipv4: { address: g.ipv4.address, domains: g.ipv4.domains.join('\n') },
        ipv6: { address: g.ipv6.address, domains: g.ipv6.domains.join('\n') }
      };
    }),
    tasks: buildTasks(state).map(function (t) {
      return publicTask(t, state.status[taskKey(t)]);
    })
  };
}

function providers() {
  return Object.keys(PROVIDERS).map(function (id) {
    const p = PROVIDERS[id];
    return {
      id: id,
      label: p.label,
      keyLabel: p.keyLabel,
      secretLabel: p.secretLabel,
      keyHint: p.keyHint,
      needsSecret: p.needsSecret !== false,
      minTtl: p.minTtl,
      maxTtl: p.maxTtl,
      ttl: p.ttl
    };
  });
}

module.exports = {
  start: start,
  config: config,
  save: saveForm,
  providers: providers,
  runAll: runAll,
  getLogs: function () { return logs.slice(-200); },
  intervalSeconds: INTERVAL
};
