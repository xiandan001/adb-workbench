const https = require('https');
const fs = require('fs');
const path = require('path');

const token = process.env.GH_TOKEN;
const repo = 'xiandan001/adb-workbench';
const tag = 'v4.1.3';

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'adb-workbench-uploader',
        'Accept': 'application/vnd.github+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function uploadAsset(uploadUrl, filePath, fileName) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const url = new URL(uploadUrl.replace('{?name,label}', `?name=${encodeURIComponent(fileName)}`));
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'adb-workbench-uploader',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileData.length
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(fileData);
    req.end();
  });
}

async function main() {
  console.log('Getting release info for', tag);
  const release = await apiRequest('GET', `/repos/${repo}/releases/tags/${tag}`);
  if (!release.id) {
    console.error('Release not found:', release);
    process.exit(1);
  }
  console.log('Release ID:', release.id);

  // Check if latest.yml already exists
  const existing = release.assets.find(a => a.name === 'latest.yml');
  if (existing) {
    console.log('latest.yml already exists, deleting...');
    await apiRequest('DELETE', `/repos/${repo}/releases/assets/${existing.id}`);
    console.log('Deleted old latest.yml');
  }

  // Upload latest.yml
  const ymlPath = path.join(__dirname, '..', 'release', 'latest.yml');
  console.log('Uploading latest.yml...');
  const result = await uploadAsset(release.upload_url, ymlPath, 'latest.yml');
  if (result.id) {
    console.log('SUCCESS! latest.yml uploaded, asset ID:', result.id);
  } else {
    console.error('Upload failed:', result);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
