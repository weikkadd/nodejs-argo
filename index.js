#!/usr/bin/env node
/**
 * nodejs-argo 轻量版 (去掉 Argo / WARP / 订阅上传)
 * 适用于 Node 容器 (Pelican / PaaS) 有公网 IP 的场景
 * 只保留: sing-box 代理 + 订阅生成 + 哪吒探针(v0) + 自动保活 + Web 服务
 */

const express = require("express");
const app = express();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require('dotenv').config();
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);

// ================== 环境变量 ==================
const FILE_PATH = process.env.FILE_PATH || '.npm';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || '0a6568ff-ea3c-4271-9020-450560e10d63';
const NAME = process.env.NAME || '';
const CFIP = process.env.CFIP || 'saas.sin.fan';
const CFPORT = process.env.CFPORT || 443;
const PROJECT_URL = process.env.PROJECT_URL || '';
const AUTO_ACCESS = process.env.AUTO_ACCESS || false;
// 代理协议端口 (留空=不启用)
const TUIC_PORT = process.env.TUIC_PORT || '';
const HY2_PORT = process.env.HY2_PORT || '';
const REALITY_PORT = process.env.REALITY_PORT || '';
const S5_PORT = process.env.S5_PORT || '';
// 哪吒探针 (留空=不启用)
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';
const NEZHA_PORT = process.env.NEZHA_PORT || '';
const NEZHA_KEY = process.env.NEZHA_KEY || '';
// Telegram 推送 (留空=不推送)
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';

// ================== 初始化 ==================
let privateKey = '';
let publicKey = '';

function generateRandomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

const sbName = generateRandomName();
const agentName = generateRandomName();
const subPath = path.join(FILE_PATH, 'sub.txt');
const listPath = path.join(FILE_PATH, 'list.txt');
const configPath = path.join(FILE_PATH, 'config.json');

if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
  console.log(`${FILE_PATH} created`);
}

function isValidPort(port) {
  try {
    if (!port) return false;
    const n = parseInt(port);
    return !isNaN(n) && n >= 1 && n <= 65535;
  } catch { return false; }
}

// ================== 下载文件 ==================
function getSystemArchitecture() {
  const arch = process.arch;
  if (arch === 'arm64' || arch === 'arm') return 'arm';
  return 'amd64';
}

async function downloadFile(fileName, fileUrl) {
  const filePath = path.join(FILE_PATH, fileName);
  try {
    const response = await axios({ url: fileUrl, responseType: 'stream', timeout: 30000 });
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    fs.chmodSync(filePath, 0o775);
    console.log(`Downloaded ${fileName}`);
    return true;
  } catch (err) {
    console.error(`Download ${fileName} failed: ${err.message}`);
    return false;
  }
}

// ================== 生成 Reality 密钥 ==================
async function generateRealityKeys() {
  const keyFilePath = path.join(FILE_PATH, 'key.txt');
  if (fs.existsSync(keyFilePath)) {
    const content = fs.readFileSync(keyFilePath, 'utf8');
    privateKey = (content.match(/PrivateKey:\s*(.*)/) || [])[1] || '';
    publicKey = (content.match(/PublicKey:\s*(.*)/) || [])[1] || '';
    if (privateKey && publicKey) {
      console.log('Reality keys loaded from file');
      return;
    }
  }
  try {
    const stdout = execSync(`${path.join(FILE_PATH, sbName)} generate reality-keypair`, { encoding: 'utf8' });
    privateKey = (stdout.match(/PrivateKey:\s*(.*)/) || [])[1] || '';
    publicKey = (stdout.match(/PublicKey:\s*(.*)/) || [])[1] || '';
    if (privateKey && publicKey) {
      fs.writeFileSync(keyFilePath, `PrivateKey: ${privateKey}\nPublicKey: ${publicKey}\n`);
      console.log('Reality keys generated and saved');
    }
  } catch (err) {
    console.error('Failed to generate reality keys:', err.message);
  }
}

// ================== 生成 TLS 证书 ==================
async function generateCert() {
  const keyPath = path.join(FILE_PATH, 'private.key');
  const certPath = path.join(FILE_PATH, 'cert.pem');
  try {
    execSync('which openssl', { encoding: 'utf8' });
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}"`, { stdio: 'ignore' });
    execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com"`, { stdio: 'ignore' });
    console.log('TLS certificate generated');
  } catch {
    // OpenSSL 不存在, 用预定义证书
    fs.writeFileSync(keyPath, `-----BEGIN EC PARAMETERS-----
BggqhkjOPQMBBw==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/++siNnfBYsdUYoAoGCCqGSM49
AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASANnngZreoQDF16ARa
/TsyLyFoPkhLxSbehH/NBEjHtSZGaDhMqQ==
-----END EC PRIVATE KEY-----`);
    fs.writeFileSync(certPath, `-----BEGIN CERTIFICATE-----
MIIBejCCASGgAwIBAgIUfWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwOTE4MTgyMDIyWhcNMzUwOTE2MTgy
MDIyWjATMREwDwYDVQQDDAhiaW5nLmNvbTBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdegEWv07Mi8h
aD5IS8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBBTV1cFID7UISE7PLTBR
BfGbgkrMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgkrMNzAPBgNVHRMB
Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIAIDAJvg0vd/ytrQVvEcSm6XTlB+
eQ6OFb9LbLYL9f+sAiAffoMbi4y/0YUSlTtz7as9S8/lciBF5VCUoVIKS+vX2g==
-----END CERTIFICATE-----`);
    console.log('Predefined TLS certificate used');
  }
}

// ================== 生成 sing-box 配置 ==================
function generateConfig() {
  const config = {
    log: { disabled: true },
    inbounds: [],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };

  // VMess (使用 PORT 作为 vmess ws 端口, 兼容旧版)
  config.inbounds.push({
    tag: 'vmess-ws-in',
    type: 'vmess',
    listen: '::',
    listen_port: parseInt(PORT),
    users: [{ uuid: UUID }],
    transport: { type: 'ws', path: '/vmess-ws', early_data_header_name: 'Sec-WebSocket-Protocol' }
  });

  // VLESS Reality
  if (isValidPort(REALITY_PORT)) {
    config.inbounds.push({
      tag: 'vless-in', type: 'vless', listen: '::', listen_port: parseInt(REALITY_PORT),
      users: [{ uuid: UUID, flow: 'xtls-rprx-vision' }],
      tls: { enabled: true, server_name: 'www.iij.ad.jp',
        reality: { enabled: true, handshake: { server: 'www.iij.ad.jp', server_port: 443 },
          private_key: privateKey, short_id: [''] } }
    });
  }

  // Hysteria2
  if (isValidPort(HY2_PORT)) {
    config.inbounds.push({
      tag: 'hysteria-in', type: 'hysteria2', listen: '::', listen_port: parseInt(HY2_PORT),
      users: [{ password: UUID }], masquerade: 'https://bing.com',
      tls: { enabled: true, alpn: ['h3'],
        certificate_path: path.join(FILE_PATH, 'cert.pem'), key_path: path.join(FILE_PATH, 'private.key') }
    });
  }

  // TUIC
  if (isValidPort(TUIC_PORT)) {
    config.inbounds.push({
      tag: 'tuic-in', type: 'tuic', listen: '::', listen_port: parseInt(TUIC_PORT),
      users: [{ uuid: UUID, password: 'admin' }], congestion_control: 'bbr',
      tls: { enabled: true, alpn: ['h3'],
        certificate_path: path.join(FILE_PATH, 'cert.pem'), key_path: path.join(FILE_PATH, 'private.key') }
    });
  }

  // SOCKS5
  if (isValidPort(S5_PORT)) {
    config.inbounds.push({
      tag: 's5-in', type: 'socks', listen: '::', listen_port: parseInt(S5_PORT),
      users: [{ username: UUID.substring(0, 8), password: UUID.slice(-12) }]
    });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('sing-box config generated');
}

// ================== 获取 IP & ISP ==================
async function getServerIP() {
  try {
    const resp = await axios.get('http://ipv4.ip.sb', { timeout: 3000 });
    return resp.data.trim();
  } catch {
    try { return execSync('curl -sm 3 ipv4.ip.sb').toString().trim(); }
    catch { return 'IP_ERROR'; }
  }
}

async function getISP() {
  try {
    const resp = await axios.get('https://api.ip.sb/geoip', { timeout: 3000 });
    if (resp.data?.country_code && resp.data?.isp)
      return `${resp.data.country_code}-${resp.data.isp}`.replace(/\s+/g, '_');
  } catch {}
  return 'Unknown';
}

// ================== 生成订阅 ==================
async function generateLinks() {
  const SERVER_IP = await getServerIP();
  const ISP = await getISP();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;
  let subTxt = '';

  // VMess (直接用 IP + PORT)
  const vmessNode = `vmess://${Buffer.from(JSON.stringify({
    v: '2', ps: nodeName, add: SERVER_IP, port: PORT, id: UUID, aid: '0',
    scy: 'auto', net: 'ws', type: 'none', host: SERVER_IP, path: '/vmess-ws?ed=2560',
    tls: '', sni: '', alpn: '', fp: 'firefox'
  })).toString('base64')}`;
  subTxt = vmessNode;

  if (isValidPort(TUIC_PORT))
    subTxt += `\ntuic://${UUID}:admin@${SERVER_IP}:${TUIC_PORT}?sni=www.bing.com&congestion_control=bbr&udp_relay_mode=native&alpn=h3&allow_insecure=1#${nodeName}`;

  if (isValidPort(HY2_PORT))
    subTxt += `\nhysteria2://${UUID}@${SERVER_IP}:${HY2_PORT}/?sni=www.bing.com&insecure=1&alpn=h3#${nodeName}`;

  if (isValidPort(REALITY_PORT))
    subTxt += `\nvless://${UUID}@${SERVER_IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.iij.ad.jp&fp=firefox&pbk=${publicKey}&type=tcp#${nodeName}`;

  if (isValidPort(S5_PORT)) {
    const auth = Buffer.from(`${UUID.substring(0, 8)}:${UUID.slice(-12)}`).toString('base64');
    subTxt += `\nsocks://${auth}@${SERVER_IP}:${S5_PORT}#${nodeName}`;
  }

  console.log('\x1b[32m' + Buffer.from(subTxt).toString('base64') + '\x1b[0m');
  fs.writeFileSync(subPath, Buffer.from(subTxt).toString('base64'));
  fs.writeFileSync(listPath, subTxt, 'utf8');
  console.log(`${FILE_PATH}/sub.txt saved`);

  // 订阅路由
  app.get(`/${SUB_PATH}`, (req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(Buffer.from(subTxt).toString('base64'));
  });

  // 推送到 TG
  if (BOT_TOKEN && CHAT_ID) {
    try {
      await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        params: { chat_id: CHAT_ID, text: `${nodeName} 节点:\n${Buffer.from(subTxt).toString('base64')}` }
      });
      console.log('TG push success');
    } catch (e) { console.error('TG push failed:', e.message); }
  }
}

// ================== 哪吒探针 (v0) ==================
async function runNezha() {
  if (!NEZHA_SERVER || !NEZHA_PORT || !NEZHA_KEY) {
    console.log('Nezha not configured, skip');
    return;
  }
  const tlsPorts = ['443', '8443', '2096', '2087', '2083', '2053'];
  const tlsFlag = tlsPorts.includes(NEZHA_PORT) ? '--tls' : '';
  const cmd = `nohup ${path.join(FILE_PATH, agentName)} -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${tlsFlag} --disable-auto-update --report-delay 4 --skip-conn --skip-procs >/dev/null 2>&1 &`;
  try {
    await execPromise(cmd);
    console.log('Nezha agent running');
  } catch (e) { console.error('Nezha failed:', e.message); }
}

// ================== 自动保活 ==================
async function autoAccess() {
  if (AUTO_ACCESS !== 'true' && AUTO_ACCESS !== true) return;
  if (!PROJECT_URL) return;
  try {
    await axios.post('https://keep.gvrander.eu.org/add-url', { url: PROJECT_URL }, { headers: { 'Content-Type': 'application/json' } });
    console.log('Auto access task added');
  } catch (e) { console.error('Auto access failed:', e.message); }
}

// ================== 主流程 ==================
async function start() {
  console.log('=== nodejs-argo 轻量版启动 ===');

  // 1. 下载 sing-box
  const arch = getSystemArchitecture();
  const baseUrl = arch === 'arm' ? 'https://arm64.ssss.nyc.mn' : 'https://amd64.ssss.nyc.mn';
  await downloadFile(sbName, `${baseUrl}/sb`);

  // 2. 下载哪吒 agent (如果配置了)
  if (NEZHA_SERVER && NEZHA_PORT && NEZHA_KEY) {
    await downloadFile(agentName, `${baseUrl}/agent`);
  }

  // 3. 生成 Reality 密钥 + TLS 证书
  await generateRealityKeys();
  await generateCert();

  // 4. 生成 sing-box 配置
  generateConfig();

  // 5. 运行哪吒探针
  await runNezha();

  // 6. 运行 sing-box
  try {
    await execPromise(`nohup ${path.join(FILE_PATH, sbName)} run -c ${configPath} >/dev/null 2>&1 &`);
    console.log('sing-box running');
  } catch (e) { console.error('sing-box failed:', e.message); }

  // 7. 等待 sing-box 启动, 生成订阅
  await new Promise(r => setTimeout(r, 3000));
  await generateLinks();

  // 8. 自动保活
  await autoAccess();

  console.log('App is running');
  console.log('Thank you for using this script, enjoy!');
}

start();

// ================== Web 服务 ==================
app.get('/', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.send(html);
  } catch {
    res.send(`Hello!<br><br>订阅地址: /${SUB_PATH}`);
  }
});

app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));
