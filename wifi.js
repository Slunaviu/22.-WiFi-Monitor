const { execSync, exec } = require('child_process');
const os = require('os');

const platform = os.platform();

function runWin(cmd) {
  try {
    const buf = execSync(`chcp 65001 >nul 2>&1 && ${cmd}`, {
      encoding: 'buffer', timeout: 8000, shell: 'cmd.exe'
    });
    return buf.toString('utf8').trim();
  } catch { return ''; }
}

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 8000 }).trim(); }
  catch { return ''; }
}

function runAsync(cmd, opts) {
  return new Promise(resolve => {
    exec(cmd, { encoding: 'utf8', timeout: 12000, ...(opts || {}) }, (err, stdout) =>
      resolve(err ? '' : stdout.trim()));
  });
}

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (/loopback|lo$/i.test(name)) continue;
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '—';
}

function formatBytes(b) {
  if (!b || isNaN(b)) return '—';
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

// ─── Windows: detect connection type ─────────────────────────────────────────

function detectConnectionTypeWin() {
  const out = runWin('netsh wlan show interfaces');
  if (out && !/not running|не запущена|не выполняется/i.test(out)) {
    if (/State\s*:\s*connected|Состояние\s*:\s*подключено/i.test(out)) return 'wifi';
  }
  return 'ethernet';
}

// ─── WiFi (Windows) ──────────────────────────────────────────────────────────

function getWifiWindows() {
  const raw = runWin('netsh wlan show interfaces');

  function parseField(...labels) {
    for (const label of labels) {
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = raw.match(new RegExp(`^[\\s\\t]*${esc}[\\s\\t]*:[\\s\\t]*(.+)$`, 'im'));
      if (m) return m[1].trim();
    }
    return '—';
  }

  const ssid = parseField('SSID');
  const bssid = parseField('BSSID');
  const adapter = parseField('Name', 'Имя');
  const auth = parseField('Authentication', 'Проверка подлинности');
  const cipher = parseField('Cipher', 'Шифрование');
  const band = parseField('Radio type', 'Тип радио');
  const channel = parseField('Channel', 'Канал');
  const signal = parseField('Signal', 'Сигнал');
  const rxRate = parseField('Receive rate (Mbps)', 'Скорость приема (Мбит/с)', 'Скорость приёма (Мбит/с)');
  const txRate = parseField('Transmit rate (Mbps)', 'Скорость передачи (Мбит/с)');

  let frequency = '—';
  const ch = parseInt(channel);
  if (!isNaN(ch) && ch > 0) frequency = ch <= 14 ? '2.4 GHz' : '5 GHz';
  else if (/802\.11ac|802\.11ax|5\s?ghz/i.test(band)) frequency = '5 GHz';
  else if (/802\.11n|802\.11g|802\.11b|2\.4/i.test(band)) frequency = '2.4 GHz';

  const arpRaw = runWin('arp -a');
  const deviceCount = arpRaw.split('\n').filter(l =>
    /динамич|dynamic/i.test(l) &&
    /\b(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(l)
  ).length;
  const routeRaw = runWin('route print 0.0.0.0');
  const gwMatch = routeRaw.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
  const gateway = gwMatch ? gwMatch[1] : '—';

  return {
    type: 'wifi', ssid, bssid, adapter, auth, cipher, band, channel,
    signal, rxRate, txRate, frequency, deviceCount, gateway
  };
}

// ─── Ethernet (Windows) ──────────────────────────────────────────────────────

function getEthernetWindows() {
  const ipconfig = runWin('ipconfig /all');
  const blocks = ipconfig.split(/\r?\n\r?\n/);

  let adapterBlock = '';
  for (const block of blocks) {
    if (/(Ethernet|Сетевой адаптер Ethernet)/i.test(block) &&
      /IPv4|IP-адрес/i.test(block) &&
      !/169\.254/i.test(block)) {
      adapterBlock = block;
      break;
    }
  }

  function pb(block, ...labels) {
    for (const label of labels) {
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = block.match(new RegExp(`${esc}[^:]*:\\s*(.+)`, 'im'));
      if (m) return m[1].replace(/\(.*\)/, '').trim();
    }
    return '—';
  }

  const nameMatch = adapterBlock.match(/(?:Ethernet adapter|Сетевой адаптер Ethernet)\s+([^:]+):/i);
  const adapterName = nameMatch ? nameMatch[1].trim() : '—';
  const mac = pb(adapterBlock, 'Physical Address', 'Физический адрес');
  const gateway = pb(adapterBlock, 'Default Gateway', 'Основной шлюз');
  const dns = pb(adapterBlock, 'DNS Servers', 'DNS-серверы');
  const dhcpEnabled = /yes|да/i.test(pb(adapterBlock, 'DHCP Enabled', 'DHCP включен')) ? 'Да' : 'Нет';
  const dhcpServer = pb(adapterBlock, 'DHCP Server', 'DHCP-сервер');
  const leaseExp = pb(adapterBlock, 'Lease Expires', 'Срок аренды истекает');

  // Скорость адаптера
  let linkSpeed = '—';
  try {
    const wmic = runWin(`wmic nic where "NetEnabled=true and NetConnectionStatus=2" get Speed /format:list`);
    const sm = wmic.match(/Speed=(\d+)/);
    if (sm) {
      const bps = parseInt(sm[1]);
      linkSpeed = bps >= 1e9 ? `${bps / 1e9} Gbps` : bps >= 1e6 ? `${bps / 1e6} Mbps` : `${bps} bps`;
    }
  } catch { }

  const netstat = runWin('netstat -e');
  let bytesSent = '—', bytesRecv = '—';
  for (const line of netstat.split('\n')) {
    // "Bytes                    1522965088      3007390955"
    if (/^\s*Bytes\s/i.test(line)) {
      const nums = line.trim().split(/\s+/).filter(p => /^\d+$/.test(p));
      if (nums.length >= 2) {
        bytesRecv = formatBytes(parseInt(nums[0]));
        bytesSent = formatBytes(parseInt(nums[1]));
      }
      break;
    }
  }

  const arpRaw = runWin('arp -a');
  const deviceCount = arpRaw.split('\n').filter(l =>
    /динамич|dynamic/i.test(l) &&
    /\b(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(l)
  ).length;

  return {
    type: 'ethernet', adapterName, mac, gateway, dns, dhcpEnabled, dhcpServer,
    leaseExp, linkSpeed, bytesSent, bytesRecv, deviceCount
  };
}

// ─── macOS ───────────────────────────────────────────────────────────────────

function getNetworkMac() {
  const airport = run('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I');
  const isWifi = airport && !/AirPort: Off/i.test(airport) && /SSID/i.test(airport);

  if (isWifi) {
    const p = (label) => { const m = airport.match(new RegExp(`\\s${label}:\\s*(.+)`)); return m ? m[1].trim() : '—'; };
    const chNum = parseInt(p('channel'));
    const arpOut = run('arp -a');
    const gw = run('netstat -nr | grep default').match(/(\d+\.\d+\.\d+\.\d+)/);
    return {
      type: 'wifi', ssid: p('SSID'), bssid: p('BSSID'), auth: p('link auth'),
      channel: p('channel'), signal: `${p('agrCtlRSSI')} dBm`,
      rxRate: p('maxRate'), txRate: p('lastTxRate'),
      frequency: chNum > 14 ? '5 GHz' : '2.4 GHz',
      deviceCount: (arpOut.match(/\(\d+\.\d+\.\d+\.\d+\)/g) || []).length,
      gateway: gw ? gw[1] : '—', adapter: 'en0'
    };
  }

  const ifconfig = run('ifconfig en0');
  const arpOut = run('arp -a');
  const gw = run('netstat -nr | grep default').match(/(\d+\.\d+\.\d+\.\d+)/);
  return {
    type: 'ethernet', adapterName: 'en0',
    mac: (ifconfig.match(/ether ([0-9a-f:]+)/i) || [])[1] || '—',
    gateway: gw ? gw[1] : '—',
    deviceCount: (arpOut.match(/\(\d+\.\d+\.\d+\.\d+\)/g) || []).length,
    linkSpeed: '—', bytesSent: '—', bytesRecv: '—'
  };
}

// ─── Linux ───────────────────────────────────────────────────────────────────

function getNetworkLinux() {
  const nmcli = run('nmcli -t -f active,ssid,bssid,signal,security,freq,rate dev wifi 2>/dev/null');
  const activeWifi = nmcli.split('\n').find(l => l.startsWith('yes:'));

  if (activeWifi) {
    const c = activeWifi.split(':');
    const freqNum = parseFloat(c[5] || '0');
    return {
      type: 'wifi', ssid: c[1] || '—', bssid: c[2] || '—', signal: `${c[3]}%`,
      auth: c[4] || '—', txRate: c[6] || '—', rxRate: c[6] || '—',
      frequency: freqNum ? `${(freqNum / 1000).toFixed(1)} GHz` : '—',
      channel: '—', deviceCount: 0, gateway: '—', adapter: '—'
    };
  }

  const route = run('ip route | grep default');
  const gwMatch = route.match(/via (\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)/);
  return {
    type: 'ethernet', adapterName: gwMatch ? gwMatch[2] : '—',
    mac: '—', gateway: gwMatch ? gwMatch[1] : '—',
    deviceCount: 0, linkSpeed: '—', bytesSent: '—', bytesRecv: '—'
  };
}

// ─── Ping ─────────────────────────────────────────────────────────────────────

async function measureLatency() {
  if (platform !== 'win32') {
    const out = await runAsync('ping -c 4 1.1.1.1');
    const m = out.match(/rtt[^=]+=\s*[\d.]+\/([\d.]+)/);
    return m ? parseFloat(m[1]).toFixed(1) : '—';
  }
  // Windows: chcp даёт английский вывод → "Average = 19ms"
  const out = await runAsync('chcp 65001 >nul 2>&1 && ping -n 4 1.1.1.1', { shell: 'cmd.exe' });
  const m = out.match(/Average\s*=\s*(\d+)ms/i);
  return m ? m[1] : '—';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function collectAll() {
  let net;
  if (platform === 'win32') {
    net = detectConnectionTypeWin() === 'wifi' ? getWifiWindows() : getEthernetWindows();
  } else if (platform === 'darwin') {
    net = getNetworkMac();
  } else {
    net = getNetworkLinux();
  }

  return {
    ...net, localIp: getLocalIp(), latency: await measureLatency(),
    platform, hostname: os.hostname()
  };
}

module.exports = { collectAll };