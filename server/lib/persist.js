/* ═══════════════════════════════════════
   DURABLE STORAGE (no paid disk)
   Render's free tier wipes local files on every deploy. This keeps copies of
   trade-log.json and state.json on a dedicated branch of the bot's own GitHub
   repo (default "bot-data" — Render only deploys main, so saving there never
   triggers a redeploy) and pulls them back at startup.

   Turned on by setting two environment variables on Render:
     PERSIST_GITHUB_TOKEN  fine-grained token, this repo only, Contents: read & write
     PERSIST_REPO          owner/repo, e.g. Orjiakor-Chibuike-Emmanuel/orchem-bot
   Optional: PERSIST_BRANCH (default bot-data).
   Without them nothing changes: the bot behaves as before.

   Safety rule: if the restore at startup fails for any reason other than
   "nothing saved yet", saving is switched off for that run, so an empty local
   file can never overwrite a good remote copy.
═══════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN = process.env.PERSIST_GITHUB_TOKEN || '';
const REPO = process.env.PERSIST_REPO || '';
const BRANCH = process.env.PERSIST_BRANCH || 'bot-data';
const API = (process.env.PERSIST_API_BASE || 'https://api.github.com').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILES = ['trade-log.json', 'state.json'];
const MIN_GAP_MS = { 'trade-log.json': 15000, 'state.json': 120000 };

const enabled = !!(TOKEN && REPO);
let canSave = enabled;
const shas = {};          // remote blob sha per file
const lastPushedHash = {}; // content hash last pushed/restored
const timers = {};
const lastPushAt = {};
const inflight = new Set();
let branchReady = false;

function remotePath(f) { return `data/${f}`; }

async function gh(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'orchem-bot',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const hash = s => crypto.createHash('sha1').update(s).digest('hex');

async function hydrate() {
  if (!enabled) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of FILES) {
    const r = await gh('GET', `/repos/${REPO}/contents/${remotePath(f)}?ref=${encodeURIComponent(BRANCH)}`);
    if (r.status === 404) { console.log(`[persist] no saved ${f} yet`); continue; }
    if (r.status !== 200 || !r.json || typeof r.json.content !== 'string') {
      canSave = false;
      console.log(`[persist] could not restore ${f} (HTTP ${r.status}) — saving is OFF this run so nothing gets overwritten`);
      continue;
    }
    let text = Buffer.from(r.json.content, 'base64').toString('utf8');
    try {
      const obj = JSON.parse(text);
      // A restart is never mid-scan.
      if (f === 'state.json' && obj && typeof obj === 'object') {
        obj.status = 'IDLE';
        text = JSON.stringify(obj, null, 2);
      }
    } catch (e) {
      canSave = false;
      console.log(`[persist] saved ${f} is not valid JSON — saving is OFF this run`);
      continue;
    }
    fs.writeFileSync(path.join(DATA_DIR, f), text);
    shas[f] = r.json.sha;
    lastPushedHash[f] = hash(text);
    console.log(`[persist] restored ${f} from ${REPO}@${BRANCH}`);
  }
}

async function ensureBranch() {
  if (branchReady) return true;
  const b = await gh('GET', `/repos/${REPO}/branches/${encodeURIComponent(BRANCH)}`);
  if (b.status === 200) { branchReady = true; return true; }
  if (b.status !== 404) return false;
  const repo = await gh('GET', `/repos/${REPO}`);
  if (repo.status !== 200) return false;
  const base = await gh('GET', `/repos/${REPO}/git/ref/heads/${encodeURIComponent(repo.json.default_branch)}`);
  if (base.status !== 200) return false;
  const made = await gh('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: base.json.object.sha });
  branchReady = made.status === 201 || made.status === 422; // 422 = already exists
  return branchReady;
}

async function pushFile(f) {
  if (!canSave) return;
  const file = path.join(DATA_DIR, f);
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const h = hash(text);
  if (h === lastPushedHash[f]) return;
  if (!(await ensureBranch())) { console.log('[persist] branch not ready, will retry'); throw new Error('branch'); }

  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      message: `bot data: ${f}`,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: BRANCH
    };
    if (shas[f]) body.sha = shas[f];
    const r = await gh('PUT', `/repos/${REPO}/contents/${remotePath(f)}`, body);
    if (r.status === 200 || r.status === 201) {
      shas[f] = r.json.content.sha;
      lastPushedHash[f] = h;
      lastPushAt[f] = Date.now();
      return;
    }
    if (r.status === 409 || r.status === 422) {
      // sha out of date: fetch the current one and retry once
      const cur = await gh('GET', `/repos/${REPO}/contents/${remotePath(f)}?ref=${encodeURIComponent(BRANCH)}`);
      shas[f] = cur.status === 200 ? cur.json.sha : undefined;
      continue;
    }
    console.log(`[persist] save of ${f} failed (HTTP ${r.status})`);
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error('sha conflict');
}

// Called after every local write. Coalesces bursts into one push.
function schedule(file) {
  if (!canSave) return;
  const f = path.basename(file);
  if (!FILES.includes(f) || timers[f]) return;
  const gap = MIN_GAP_MS[f] || 30000;
  const wait = Math.max(3000, gap - (Date.now() - (lastPushAt[f] || 0)));
  timers[f] = setTimeout(async () => {
    timers[f] = null;
    const p = pushFile(f).catch(e => {
      console.log(`[persist] ${f}: ${e.message}`);
      schedule(f); // try again later
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }, wait);
  if (timers[f].unref) timers[f].unref();
}

// Push everything pending right now (used on shutdown).
async function flush() {
  if (!canSave) return;
  for (const f of FILES) {
    if (timers[f]) { clearTimeout(timers[f]); timers[f] = null; }
  }
  await Promise.allSettled([...inflight]);
  for (const f of FILES) {
    try { await pushFile(f); } catch (e) { console.log(`[persist] final save of ${f} failed: ${e.message}`); }
  }
}

module.exports = { enabled, hydrate, schedule, flush, _state: () => ({ canSave, shas }) };
