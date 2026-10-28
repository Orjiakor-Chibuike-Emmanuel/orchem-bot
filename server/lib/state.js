/* ═══════════════════════════════════════
   PERSISTENT STATE
   On the browser version this was localStorage.
   Here it's a JSON file on disk, loaded once at
   boot and written back after every change.

   IMPORTANT (Render specific): Render's filesystem
   is NOT persistent across deploys/restarts unless
   you attach a Render Disk to this service. Without
   one, trade-log history and today's alert state
   reset whenever the service restarts (a deploy, a
   crash, or the free-tier instance spinning down).
   That's fine for the watchlist/alert state (worst
   case it just re-scans), but means the trade log
   is NOT a durable record on its own — treat the
   Telegram messages as the durable copy until a
   disk is attached. See README.md.
═══════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const persist = require('./persist');

// DATA_DIR can be pointed at a mounted Render Disk later for durable
// storage across restarts — see README.md. Defaults to the local data/
// folder, which is NOT persistent on Render without a disk attached.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TRADE_LOG_FILE = path.join(DATA_DIR, 'trade-log.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function todayUTCStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    persist.schedule(file);
  } catch (e) {
    console.log(`[state] failed to write ${file}:`, e.message);
  }
}

const DEFAULT_STATE = () => ({
  watchlist: [],
  confirmResults: [],
  engulfResults: [],
  auxResults: [],
  lastScan: null,
  status: 'IDLE',
  bannedUntil: null, // timestamp — set when Bybit's market-data API rate-limits this IP, checked before starting any new scan
  tgQueue: [],
  alertState: {
    date: todayUTCStr(),
    tg: [],
    confirmed: [],
    invalidated: [],
    exhaustedLogged: []
  }
});

// Load once at boot.
let state = readJsonSafe(STATE_FILE, null) || DEFAULT_STATE();

// If the saved alert state is from a previous UTC day, reset it — same
// effect as the midnight watchlist-clear timer in the browser version.
if (!state.alertState || state.alertState.date !== todayUTCStr()) {
  state.alertState = DEFAULT_STATE().alertState;
  state.watchlist = [];
  state.confirmResults = [];
}

let tradeLog = readJsonSafe(TRADE_LOG_FILE, []);

function save() {
  writeJsonSafe(STATE_FILE, state);
}

function saveTradeLog() {
  writeJsonSafe(TRADE_LOG_FILE, tradeLog);
}

// Convenience Set-like helpers so the ported logic (which used Set.has/add)
// can stay close to the original — alertState arrays are the on-disk form,
// these wrap them as Sets for in-memory use during a scan cycle.
function alertSets() {
  return {
    tg: new Set(state.alertState.tg),
    confirmed: new Set(state.alertState.confirmed),
    invalidated: new Set(state.alertState.invalidated),
    exhaustedLogged: new Set(state.alertState.exhaustedLogged)
  };
}

function saveAlertSets(sets) {
  state.alertState = {
    date: todayUTCStr(),
    tg: [...sets.tg],
    confirmed: [...sets.confirmed],
    invalidated: [...sets.invalidated],
    exhaustedLogged: [...sets.exhaustedLogged]
  };
  save();
}

module.exports = {
  get state() { return state; },
  set state(v) { state = v; },
  get tradeLog() { return tradeLog; },
  set tradeLog(v) { tradeLog = v; },
  save,
  saveTradeLog,
  todayUTCStr,
  alertSets,
  saveAlertSets
};
