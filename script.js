/* =====================================================
   CARAVAN WHEEL PICKER — script.js

   Storage strategy:
   ─────────────────
   PRIMARY: GitHub Gist (shared across all users)
     - Admin sets a GitHub token + Gist ID once.
     - All writes go to the Gist via GitHub API.
     - All users auto-refresh from Gist every 30s.
     - Sync status shown in header (⬤ synced / ⬤ local / ⬤ error)

   FALLBACK: localStorage
     - Used when Gist is not configured, or as a write-ahead
       buffer if the Gist fetch fails.

   Participant shape:
     { name, leaderWins, vipWins, guardWins, isGuard }

   Weights are independent per role:
     leaderWeight(p) = 1 / (1 + leaderWins)
     vipWeight(p)    = 1 / (1 + vipWins)
     guardWeight(p)  = 1 / (1 + guardWins)

   Spin sequence:
     1. Leader — everyone
     2. VIP    — everyone except leader
        OR
        Guard  — isGuard members only, except leader
   ===================================================== */

// ── Keys ──
const STORAGE_KEY  = 'caravan_wheel_v3';  // localStorage fallback
const PW_HASH_KEY  = 'caravan_pw_hash';
const SESSION_KEY  = 'caravan_admin_open';
const GIST_TOKEN_KEY = 'caravan_gist_token';
const GIST_ID_KEY    = 'caravan_gist_id';
const GIST_FILENAME  = 'caravan_data.json';
const DEFAULT_PW   = 'qy8DRAHCaLcF';

// ── State ──
let participants = [];
let currentRound = { leaderWinner: null, secondRole: null, secondWinner: null };
let isSpinning   = false;
let pendingClear = null;
let expandedIdx  = null;
let syncInterval = null;  // setInterval handle for auto-refresh

// ── Canvas ──
const canvas = document.getElementById('wheelCanvas');
const ctx    = canvas.getContext('2d');

const SEGMENT_COLORS = [
  '#8b4513','#6b3410','#a0522d','#7a3b1e',
  '#5c2c0e','#9b5523','#3e1f08','#b06030',
  '#4a2510','#c07040','#6a3318','#503010',
];

const ALL_MODALS = ['celebrationModal','adminModal','gistSetupModal','clearModal'];

/* ====================================================
   INIT
   ==================================================== */

window.addEventListener('DOMContentLoaded', async () => {
  // Store hashed default password on first visit
  if (!localStorage.getItem(PW_HASH_KEY)) {
    localStorage.setItem(PW_HASH_KEY, await sha256(DEFAULT_PW));
  }

  // Load from localStorage first so UI is instant
  loadLocalStorage();
  renderAll();

  // Restore admin session if previously unlocked
  if (localStorage.getItem(SESSION_KEY) === 'true') applyAdminUnlock();

  // Try to pull latest data from Gist
  await syncFromGist();

  // Auto-refresh from Gist every 30 seconds so all viewers stay current
  syncInterval = setInterval(syncFromGist, 30000);
});

/* ====================================================
   SHA-256  (Web Crypto API — zero dependencies)
   ==================================================== */

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ====================================================
   GIST SYNC
   ==================================================== */

function gistToken() { return localStorage.getItem(GIST_TOKEN_KEY) || ''; }
function gistId()    { return localStorage.getItem(GIST_ID_KEY)    || ''; }
function gistConfigured() { return !!(gistToken() && gistId()); }

/** Set the header sync dot: 'synced' | 'local' | 'error' | 'syncing' */
function setSyncStatus(state) {
  const el = document.getElementById('syncStatus');
  const map = {
    synced:  { text: '⬤ synced',  cls: 'sync-ok'      },
    local:   { text: '⬤ local',   cls: 'sync-local'    },
    error:   { text: '⬤ error',   cls: 'sync-error'    },
    syncing: { text: '⬤ syncing', cls: 'sync-syncing'  },
  };
  const s = map[state] || map.local;
  el.textContent = s.text;
  el.className   = 'sync-status ' + s.cls;
}

/** Pull data from Gist and update participants if newer */
async function syncFromGist() {
  if (!gistConfigured()) { setSyncStatus('local'); return; }
  setSyncStatus('syncing');
  try {
    const res  = await fetch(`https://api.github.com/gists/${gistId()}`, {
      headers: {
        'Authorization': `token ${gistToken()}`,
        'Accept': 'application/vnd.github.v3+json',
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data    = await res.json();
    const content = data.files?.[GIST_FILENAME]?.content;
    if (!content) throw new Error('File not found in Gist');
    const parsed = JSON.parse(content);
    participants = migrateParticipants(parsed);
    saveLocalStorage(); // keep local in sync
    renderAll();
    setSyncStatus('synced');
  } catch(e) {
    console.warn('Gist sync failed:', e);
    setSyncStatus('error');
  }
}

/** Write current participants to Gist */
async function pushToGist() {
  if (!gistConfigured()) return;
  setSyncStatus('syncing');
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId()}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${gistToken()}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: { content: JSON.stringify(participants, null, 2) }
        }
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSyncStatus('synced');
  } catch(e) {
    console.warn('Gist push failed:', e);
    setSyncStatus('error');
  }
}

/** Save locally AND push to Gist */
function saveData() {
  saveLocalStorage();
  pushToGist(); // fire and forget — non-blocking
}

/** Show Gist setup modal (admin only) */
function openGistSetup() {
  document.getElementById('gistToken').value = gistToken();
  document.getElementById('gistId').value    = gistId();
  document.getElementById('gistSetupError').style.display = 'none';
  openModal('gistSetupModal');
}

/** Save Gist config and do an immediate sync test */
async function saveGistConfig() {
  const token = document.getElementById('gistToken').value.trim();
  const id    = document.getElementById('gistId').value.trim();
  const errEl = document.getElementById('gistSetupError');

  if (!token || !id) {
    errEl.textContent = 'Both fields are required.';
    errEl.style.display = 'block';
    return;
  }

  // Test the connection first
  errEl.textContent = 'Testing connection…';
  errEl.style.display = 'block';
  errEl.style.color = 'var(--gold)';

  try {
    const res = await fetch(`https://api.github.com/gists/${id}`, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} — check your Gist ID and token.`);

    // If the Gist exists but doesn't have our file yet, push current data to create it
    const gistData = await res.json();
    if (!gistData.files?.[GIST_FILENAME]) {
      // Initialise the Gist file with current data
      await fetch(`https://api.github.com/gists/${id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: { [GIST_FILENAME]: { content: JSON.stringify(participants, null, 2) } }
        })
      });
    }

    localStorage.setItem(GIST_TOKEN_KEY, token);
    localStorage.setItem(GIST_ID_KEY, id);
    closeModal();
    await syncFromGist();

  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.color = '#e74c3c';
    errEl.style.display = 'block';
  }
}

function showGistHelp() {
  alert('Your Gist ID is the long string in the URL when you open a Gist.\n\nExample URL:\nhttps://gist.github.com/yourusername/a1b2c3d4e5f6a1b2c3d4\n\nThe ID is: a1b2c3d4e5f6a1b2c3d4');
  return false;
}

/* ====================================================
   LOCAL STORAGE  (fallback / write-ahead cache)
   ==================================================== */

function saveLocalStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(participants));
}

function loadLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) participants = migrateParticipants(JSON.parse(raw));
  } catch(e) { participants = []; }
}

/** Ensure all participant objects have all required fields (handles old data) */
function migrateParticipants(arr) {
  return arr.map(p => ({
    name:       p.name       ?? '',
    leaderWins: p.leaderWins ?? 0,
    vipWins:    p.vipWins    ?? 0,
    guardWins:  p.guardWins  ?? 0,
    isGuard:    p.isGuard    ?? false,
  }));
}

/* ====================================================
   ADMIN
   ==================================================== */

function toggleAdminPrompt() {
  if (localStorage.getItem(SESSION_KEY) === 'true') {
    lockAdmin();
  } else {
    openModal('adminModal');
    setTimeout(() => document.getElementById('adminPwInput').focus(), 80);
  }
}

async function submitAdminPassword() {
  const input = document.getElementById('adminPwInput');
  const errEl = document.getElementById('adminPwError');
  if ((await sha256(input.value)) === localStorage.getItem(PW_HASH_KEY)) {
    input.value = '';
    errEl.style.display = 'none';
    closeModal();
    localStorage.setItem(SESSION_KEY, 'true');
    applyAdminUnlock();
    // Prompt Gist setup if not yet configured
    if (!gistConfigured()) {
      setTimeout(() => openGistSetup(), 400);
    }
  } else {
    errEl.style.display = 'block';
    input.select();
  }
}

function applyAdminUnlock() {
  document.body.classList.add('admin-unlocked');
  document.getElementById('adminActions').style.display  = 'block';
  document.getElementById('importSection').style.display = 'block';
  const btn = document.getElementById('adminToggleBtn');
  btn.textContent = '🔓 Admin';
  btn.classList.add('unlocked');
}

function lockAdmin() {
  localStorage.removeItem(SESSION_KEY);
  document.body.classList.remove('admin-unlocked');
  document.getElementById('adminActions').style.display  = 'none';
  document.getElementById('importSection').style.display = 'none';
  const btn = document.getElementById('adminToggleBtn');
  btn.textContent = '🔒 Admin';
  btn.classList.remove('unlocked');
}

/* ====================================================
   MODAL SYSTEM
   ==================================================== */

function openModal(id) {
  ALL_MODALS.forEach(m => document.getElementById(m).style.display = 'none');
  document.getElementById(id).style.display = 'block';
  document.getElementById('modalBackdrop').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modalBackdrop').style.display = 'none';
  ALL_MODALS.forEach(m => document.getElementById(m).style.display = 'none');
  document.getElementById('adminPwInput').value = '';
  document.getElementById('adminPwError').style.display = 'none';
  pendingClear = null;
}

document.getElementById('modalBackdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('modalBackdrop')) closeModal();
});

/* ====================================================
   NAME MANAGEMENT
   ==================================================== */

function importNames() {
  const box   = document.getElementById('importBox');
  const lines = box.value.split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0;
  lines.forEach(name => {
    if (!participants.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      participants.push({ name, leaderWins: 0, vipWins: 0, guardWins: 0, isGuard: false });
      added++;
    }
  });
  box.value = '';
  saveData();
  renderAll();
  if (added === 0) alert('No new names to add (duplicates skipped).');
}

function addSingleName() {
  const input = document.getElementById('singleName');
  const name  = input.value.trim();
  if (!name) return;
  if (participants.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    alert(`"${name}" is already in the list.`);
    return;
  }
  participants.push({ name, leaderWins: 0, vipWins: 0, guardWins: 0, isGuard: false });
  input.value = '';
  saveData();
  renderAll();
}

function removeName(index) {
  const name = participants[index]?.name || 'this person';
  if (!confirm(`Remove "${name}" from the list?`)) return;
  participants.splice(index, 1);
  if (expandedIdx === index) expandedIdx = null;
  saveData();
  renderAll();
}

function toggleGuardFlag(index) {
  participants[index].isGuard = !participants[index].isGuard;
  saveData();
  renderNameList();
}

function clearImportBox() { document.getElementById('importBox').value = ''; }

function clearSearch() {
  document.getElementById('searchBox').value = '';
  renderNameList();
}

/* ====================================================
   CLEAR STATS
   ==================================================== */

function confirmClear(type) {
  pendingClear = type;
  const titles = {
    leader: '↺ Reset Leader Stats',
    vip:    '↺ Reset VIP Stats',
    guard:  '↺ Reset Guard Stats',
    flags:  '↺ Clear Guard Flags',
    all:    '🗑 Clear Everything',
  };
  const subtitles = {
    leader: 'This will zero out all Caravan Leader win counts.',
    vip:    'This will zero out all VIP win counts.',
    guard:  'This will zero out all Guard win counts.',
    flags:  'This will remove the Guard designation from all members.',
    all:    'This will permanently delete all members and every stat:',
  };
  document.getElementById('clearModalTitle').textContent    = titles[type];
  document.getElementById('clearModalSubtitle').textContent = subtitles[type];
  const nameListEl = document.getElementById('clearModalNameList');
  if (type === 'all' && participants.length > 0) {
    nameListEl.style.display = 'block';
    nameListEl.innerHTML = participants.map(p => `<div>${escapeHtml(p.name)}</div>`).join('');
  } else {
    nameListEl.style.display = 'none';
  }
  openModal('clearModal');
}

function executeConfirmedClear() {
  switch(pendingClear) {
    case 'leader': participants.forEach(p => p.leaderWins = 0); break;
    case 'vip':    participants.forEach(p => p.vipWins    = 0); break;
    case 'guard':  participants.forEach(p => p.guardWins  = 0); break;
    case 'flags':  participants.forEach(p => p.isGuard    = false); break;
    case 'all':    participants = []; expandedIdx = null; break;
  }
  currentRound = { leaderWinner: null, secondRole: null, secondWinner: null };
  saveData();
  closeModal();
  renderAll();
  setStatus(pendingClear === 'all' ? 'All cleared.' : 'Stats updated.');
}

/* ====================================================
   WEIGHTED RANDOM  (independent per role)
   ==================================================== */

function leaderWeight(p) { return 1 / (1 + p.leaderWins); }
function vipWeight(p)    { return 1 / (1 + p.vipWins); }
function guardWeight(p)  { return 1 / (1 + p.guardWins); }

function weightedPick(pool, weightFn) {
  const weights = pool.map(weightFn);
  const total   = weights.reduce((a, b) => a + b, 0);
  let rand      = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/* ====================================================
   SPIN
   ==================================================== */

function spinFor(role) {
  if (isSpinning) return;
  let pool, weightFn;

  if (role === 'leader') {
    if (participants.length < 2) { alert('Add at least 2 participants first.'); return; }
    pool = [...participants]; weightFn = leaderWeight;

  } else if (role === 'vip') {
    pool = participants.filter(p => p.name !== currentRound.leaderWinner);
    if (!pool.length) { alert('Not enough participants.'); return; }
    weightFn = vipWeight;

  } else if (role === 'guard') {
    pool = participants.filter(p => p.isGuard && p.name !== currentRound.leaderWinner);
    if (!pool.length) {
      alert('No Guard-eligible members.\nMark members as Guard-eligible using the ✔ button next to their name.');
      return;
    }
    weightFn = guardWeight;
  }

  const winner = weightedPick(pool, weightFn);
  isSpinning   = true;
  disableAllSpinButtons(true);
  const labels = { leader: '🧭 Caravan Leader', vip: '👑 VIP', guard: '🛡️ Guard' };
  setStatus(`Spinning for ${labels[role]}…`);

  animateWheel(pool, winner, weightFn, () => {
    isSpinning = false;

    if (role === 'leader') {
      currentRound.leaderWinner = winner.name;
      winner.leaderWins++;
      setStatus(`🧭 Leader: ${winner.name} — now choose VIP or Guard!`);
      highlightName(winner.name, 'leader');
      document.getElementById('step1Buttons').style.display = 'none';
      document.getElementById('step2Buttons').style.display = 'flex';

    } else {
      currentRound.secondRole   = role;
      currentRound.secondWinner = winner.name;
      if (role === 'vip')   winner.vipWins++;
      if (role === 'guard') winner.guardWins++;
      setStatus(`${labels[role]}: ${winner.name} — round complete!`);
      highlightName(winner.name, role);
      setTimeout(showCelebrationModal, 400);
      document.getElementById('step1Buttons').style.display = 'flex';
      document.getElementById('step2Buttons').style.display = 'none';
      disableAllSpinButtons(false);
    }

    saveData();
    renderNameList();
  });
}

/* ====================================================
   WHEEL ANIMATION
   ==================================================== */

function animateWheel(pool, winner, weightFn, onDone) {
  const totalWeight   = pool.reduce((s, p) => s + weightFn(p), 0);
  const segmentAngles = pool.map(p => (weightFn(p) / totalWeight) * Math.PI * 2);
  const winnerIdx     = pool.indexOf(winner);
  let accumulated     = 0;
  for (let i = 0; i < winnerIdx; i++) accumulated += segmentAngles[i];
  const segMid      = accumulated + segmentAngles[winnerIdx] / 2;
  const extraSpins  = 5 + Math.floor(Math.random() * 3);
  const targetAngle = extraSpins * Math.PI * 2 + (-Math.PI / 2 - segMid);
  const duration    = 4000;
  const startTime   = performance.now();
  const easeOut     = t => 1 - Math.pow(1 - t, 3);

  function frame(now) {
    const t = Math.min((now - startTime) / duration, 1);
    drawWheel(pool, segmentAngles, targetAngle * easeOut(t));
    if (t < 1) requestAnimationFrame(frame);
    else { drawWheel(pool, segmentAngles, targetAngle); disableAllSpinButtons(false); onDone(); }
  }
  requestAnimationFrame(frame);
}

function drawWheel(pool, segmentAngles, rotation) {
  const W = canvas.width, H = canvas.height, cx = W/2, cy = H/2;
  const r = Math.min(cx, cy) - 4;
  ctx.clearRect(0, 0, W, H);
  let start = rotation;
  pool.forEach((p, i) => {
    const end = start + segmentAngles[i];
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end); ctx.closePath();
    ctx.fillStyle = SEGMENT_COLORS[i % SEGMENT_COLORS.length]; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    const mid = start + (end - start) / 2;
    const maxChars = Math.max(6, Math.floor(360 / pool.length / 6));
    const label = p.name.length > maxChars ? p.name.slice(0, maxChars-1)+'…' : p.name;
    ctx.save();
    ctx.translate(cx + Math.cos(mid)*r*0.68, cy + Math.sin(mid)*r*0.68);
    ctx.rotate(mid + Math.PI/2);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(9, Math.min(14, 280/pool.length))}px Lato,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3;
    ctx.fillText(label, 0, 0); ctx.restore();
    start = end;
  });
  ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI*2);
  ctx.fillStyle = '#1a1208'; ctx.fill();
  ctx.strokeStyle = '#d4952a'; ctx.lineWidth = 3; ctx.stroke();
  ctx.font = '18px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🏕️', cx, cy);
}

/* ====================================================
   EXPAND ROW  (admin: click name → +/- weight controls)
   ==================================================== */

function toggleExpand(idx) {
  if (!document.body.classList.contains('admin-unlocked')) return;
  expandedIdx = (expandedIdx === idx) ? null : idx;
  renderNameList();
}

function adjustWins(idx, field, delta) {
  const p = participants[idx];
  if (!p) return;
  p[field] = Math.max(0, p[field] + delta);
  saveData();
  renderNameList();
  // Redraw wheel with updated weights
  if (participants.length > 0) {
    const total  = participants.reduce((s, q) => s + leaderWeight(q), 0);
    const angles = participants.map(q => (leaderWeight(q) / total) * Math.PI * 2);
    drawWheel(participants, angles, 0);
  }
}

/* ====================================================
   RENDER
   ==================================================== */

function renderAll() {
  renderNameList();
  if (participants.length > 0) {
    const total  = participants.reduce((s, p) => s + leaderWeight(p), 0);
    const angles = participants.map(p => (leaderWeight(p) / total) * Math.PI * 2);
    drawWheel(participants, angles, 0);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#5a3e1b'; ctx.font = '14px Lato,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Add names to see the wheel', canvas.width/2, canvas.height/2);
  }
  document.getElementById('nameCount').textContent = participants.length;
}

function renderNameList() {
  const list  = document.getElementById('nameList');
  const noRes = document.getElementById('noResults');
  const query = document.getElementById('searchBox').value.trim().toLowerCase();
  list.innerHTML = '';

  if (!participants.length) {
    noRes.style.display = 'none';
    list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem 0">No participants yet.</p>';
    document.getElementById('nameCount').textContent = 0;
    return;
  }

  const filtered = query
    ? participants.filter(p => p.name.toLowerCase().includes(query))
    : participants;

  noRes.style.display = filtered.length === 0 ? 'block' : 'none';

  const totalLeaderW = filtered.reduce((s, p) => s + leaderWeight(p), 0);
  const totalVipW    = participants.reduce((s, p) => s + vipWeight(p), 0);
  const guardPool    = participants.filter(p => p.isGuard);
  const totalGuardW  = guardPool.reduce((s, p) => s + guardWeight(p), 0);

  filtered.forEach(p => {
    const idx        = participants.indexOf(p);
    const oddsPercent = totalLeaderW > 0
      ? ((leaderWeight(p) / totalLeaderW) * 100).toFixed(1) : '0.0';
    const isExpanded = (expandedIdx === idx);

    const wrap = document.createElement('div');
    wrap.className = 'name-wrap';

    const row = document.createElement('div');
    row.className = 'name-row' + (p.isGuard ? ' is-guard' : '') + (isExpanded ? ' expanded' : '');
    row.id = `row-${idx}`;

    row.innerHTML = `
      <span class="name-text name-clickable" onclick="toggleExpand(${idx})" title="Click to adjust weights">${escapeHtml(p.name)}</span>
      <span class="win-cell leader" title="Leader wins">${p.leaderWins}</span>
      <span class="win-cell vip"    title="VIP wins">${p.vipWins}</span>
      <span class="win-cell guard"  title="Guard wins">${p.guardWins}</span>
      <button class="guard-flag-btn ${p.isGuard ? 'flagged' : ''}"
        onclick="toggleGuardFlag(${idx})"
        title="${p.isGuard ? 'Remove Guard flag' : 'Mark as Guard-eligible'}">✔</button>
      <button class="del-btn" onclick="removeName(${idx})" title="Remove ${escapeHtml(p.name)}">✕</button>
      <div class="odds-bar-wrap"><div class="odds-bar-fill" style="width:${oddsPercent}%"></div></div>
    `;
    wrap.appendChild(row);

    // Expand panel — admin only, shows +/- per role with live odds
    if (isExpanded) {
      const vipOdds   = totalVipW   > 0 ? ((vipWeight(p)   / totalVipW)   * 100).toFixed(1) : '0.0';
      const guardOdds = p.isGuard && totalGuardW > 0
        ? ((guardWeight(p) / totalGuardW) * 100).toFixed(1) + '% guard odds'
        : (p.isGuard ? '100% guard odds' : 'not guard-eligible');

      const panel = document.createElement('div');
      panel.className = 'expand-panel';
      panel.innerHTML = `
        <div class="expand-title">Adjust weights for <strong>${escapeHtml(p.name)}</strong></div>
        <div class="expand-controls">
          <div class="expand-role">
            <span class="expand-label">🧭 Leader</span>
            <div class="expand-adj">
              <button class="adj-btn minus" onclick="adjustWins(${idx},'leaderWins',-1)">−</button>
              <span class="adj-val">${p.leaderWins}</span>
              <button class="adj-btn plus"  onclick="adjustWins(${idx},'leaderWins',+1)">+</button>
            </div>
            <span class="expand-odds">${oddsPercent}% leader odds</span>
          </div>
          <div class="expand-role">
            <span class="expand-label">👑 VIP</span>
            <div class="expand-adj">
              <button class="adj-btn minus" onclick="adjustWins(${idx},'vipWins',-1)">−</button>
              <span class="adj-val">${p.vipWins}</span>
              <button class="adj-btn plus"  onclick="adjustWins(${idx},'vipWins',+1)">+</button>
            </div>
            <span class="expand-odds">${vipOdds}% vip odds</span>
          </div>
          <div class="expand-role">
            <span class="expand-label">🛡️ Guard</span>
            <div class="expand-adj">
              <button class="adj-btn minus" onclick="adjustWins(${idx},'guardWins',-1)">−</button>
              <span class="adj-val">${p.guardWins}</span>
              <button class="adj-btn plus"  onclick="adjustWins(${idx},'guardWins',+1)">+</button>
            </div>
            <span class="expand-odds">${guardOdds}</span>
          </div>
        </div>
      `;
      wrap.appendChild(panel);
    }

    list.appendChild(wrap);
  });

  document.getElementById('nameCount').textContent = participants.length;
}

/* ====================================================
   CELEBRATION MODAL
   ==================================================== */

function showCelebrationModal() {
  const roleLabels  = { vip: '👑 VIP', guard: '🛡️ Guard' };
  const roleClasses = { vip: 'vip-card', guard: 'guard-card' };
  document.getElementById('modalLeader').textContent      = currentRound.leaderWinner || '—';
  document.getElementById('modalSecondLabel').textContent = roleLabels[currentRound.secondRole]  || '—';
  document.getElementById('modalSecond').textContent      = currentRound.secondWinner || '—';
  document.getElementById('modalSecondCard').className    = 'result-card ' + (roleClasses[currentRound.secondRole] || '');
  openModal('celebrationModal');
  currentRound = { leaderWinner: null, secondRole: null, secondWinner: null };
}

/* ====================================================
   HELPERS
   ==================================================== */

function highlightName(name, role) {
  const idx = participants.findIndex(p => p.name === name);
  if (idx < 0) return;
  const row = document.getElementById(`row-${idx}`);
  if (!row) return;
  row.classList.add(`highlight-${role}`);
  setTimeout(() => row.classList.remove(`highlight-${role}`), 3000);
}

function setStatus(msg) { document.getElementById('spinStatus').textContent = msg; }

function disableAllSpinButtons(state) {
  ['btnLeader','btnVip','btnGuard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = state;
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
