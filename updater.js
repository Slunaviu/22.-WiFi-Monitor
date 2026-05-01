const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const REPO       = 'Slunaviu/22.-WiFi-Monitor';
const API_URL    = `https://api.github.com/repos/${REPO}/releases/latest`;
const RAW_BASE   = `https://raw.githubusercontent.com/${REPO}/main`;
const APP_DIR    = path.dirname(process.execPath) === process.cwd()
                   ? path.dirname(require.main.filename)
                   : process.cwd();

// Файлы которые обновляем
const FILES = ['index.html', 'wifi.js', 'package.json'];

// ── helpers ──────────────────────────────────────────────────────────────────

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'wifi-monitor-updater' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'wifi-monitor-updater' } }, res => {
      // Следуем редиректам
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} для ${url}`));
      }
      const tmp = dest + '.tmp';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          fs.rename(tmp, dest, err => err ? reject(err) : resolve());
        });
      });
      out.on('error', err => { fs.unlink(tmp, () => {}); reject(err); });
    }).on('error', reject);
  });
}

function parseVersion(v) {
  return (v || '0.0.0').replace(/^v/, '').split('.').map(Number);
}

function isNewer(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

function getLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Проверяет обновления.
 * Возвращает { hasUpdate, remoteVersion, localVersion } или кидает ошибку.
 */
async function checkForUpdates() {
  const release      = await getJson(API_URL);
  const remoteVersion = release.tag_name || release.name || '0.0.0';
  const localVersion  = getLocalVersion();
  return {
    hasUpdate:     isNewer(remoteVersion, localVersion),
    remoteVersion: remoteVersion.replace(/^v/, ''),
    localVersion,
    releaseName:   release.name || remoteVersion,
    releaseNotes:  release.body || ''
  };
}

/**
 * Скачивает и заменяет файлы, затем перезапускает приложение.
 * onProgress(filename, index, total) — колбэк прогресса.
 */
async function applyUpdate(onProgress) {
  for (let i = 0; i < FILES.length; i++) {
    const filename = FILES[i];
    if (onProgress) onProgress(filename, i + 1, FILES.length);
    const url  = `${RAW_BASE}/${encodeURIComponent(filename)}`;
    const dest = path.join(APP_DIR, filename);
    await downloadFile(url, dest);
  }
  // Перезапускаем приложение
  const { exec } = require('child_process');
  const nwExec   = process.execPath;
  exec(`"${nwExec}" "${APP_DIR}"`, { detached: true });
  nw.App.quit();
}

module.exports = { checkForUpdates, applyUpdate };
