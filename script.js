/* =====================================================
   CARAVAN WHEEL PICKER — script.js

   Key systems:
   - Admin password: SHA-256 hashed, stored in localStorage.
     Admin unlock stored in localStorage (persists across page closes).
   - Three modals share one backdrop: celebration, admin login,
     confirm-clear. Only one is visible at a time.
   - Weighted fairness: w(p) = 1 / (1 + totalWins(p))
   - localStorage persists names + stats across refreshes.
   ===================================================== */

// ── Storage Keys ──
const STORAGE_KEY    = 'caravan_wheel_v2';   // participant data
const PW_HASH_KEY    = 'caravan_pw_hash';    // stored password hash
const SESSION_KEY    = 'caravan_admin_open'; // localStorage: persists across closes

// ── Admin password (plain — only used first-time setup, then hashed) ──
// CHANGE THIS if you want a different default password.
const DEFAULT_PASSWORD = 'qy8DRAHCaLcF';

// ── App State ──
let participants = [];
let currentRound = { leaderWinner: null, vipWinner: null };
let isSpinning   = false;

// ── Canvas ──
const canvas = document.getElementById('wheelCanvas');
const ctx    = canvas.getContext('2d');

const SEGMENT_COLORS = [
  '#8b4513','#6b3410','#a0522d','#7a3b1e',
  '#5c2c0e','#9b5523','#3e1f08','#b06030',
  '#4a2510','#c07040','#6a3318','#503010',
];

/* ====================================================
   INIT
   ==================================================== */

window.addEventListener('DOMContentLoaded', async () => {
  // First visit: hash and store the default password
  if (!localStorage.getItem(PW_HASH_KEY)) {
    const hash = await sha256(DEFAULT_PASSWORD);
    localStorage.setItem(PW_HASH_KEY, hash);
  }

  loadFromStorage();
  renderAll();

  // Restore admin session if they already unlocked this tab
  if (localStorage.getItem(SESSION_KEY) === 'true') {
    applyAdminUnlock();
  }
});

/* ====================================================
   PASSWORD HASHING (Web Crypto API — no libraries)
   ==================================================== */

/** Return hex SHA-256 of a string */
async function sha256(str) {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ====================================================
   ADMIN SESSION
   ==================================================== */

/** Show the admin password modal, or lock if already unlocked */
function toggleAdminPrompt() {
  if (localStorage.getItem(SESSION_KEY) === 'true') {
    // Already unlocked — clicking again locks
    lockAdmin();
  } else {
    openModal('adminModal');
    setTimeout(() => document.getElementById('adminPwInput').focus(), 100);
  }
}

/** Check entered password and unlock if correct */
async function submitAdminPassword() {
  const input   = document.getElementById('adminPwInput');
  const errEl   = document.getElementById('adminPwError');
  const entered = input.value;

  const enteredHash = await sha256(entered);
  const storedHash  = localStorage.getItem(PW_HASH_KEY);

  if (enteredHash === storedHash) {
    input.value = '';
    errEl.style.display = 'none';
    closeModal();
    localStorage.setItem(SESSION_KEY, 'true');
    applyAdminUnlock();
  } else {
    errEl.style.display = 'block';
    input.select();
  }
}

/** Apply visual/functional changes when admin is unlocked */
function applyAdminUnlock() {
  document.body.classList.add('admin-unlocked');
  document.getElementById('adminActions').style.display  = 'flex';
  document.getElementById('importSection').style.display = 'block';
  const btn = document.getElementById('adminToggleBtn');
  btn.textContent = '🔓 Admin';
  btn.classList.add('unlocked');
}

/** Lock admin (remove session, hide controls) */
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
   The backdrop is always the outer container.
   We show/hide the backdrop, and show only one inner
   modal-box at a time.
   ==================================================== */

let activeModalId = null;

/** Open the backdrop and show one inner modal by id */
function openModal(modalId) {
  // Hide all inner modals first
  ['celebrationModal','adminModal','clearAllModal'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });

  // Show the requested one
  document.getElementById(modalId).style.display = 'block';
  activeModalId = modalId;

  // Show the backdrop using flex (so centering works)
  document.getElementById('modalBackdrop').style.display = 'flex';
}

/** Close backdrop + all inner modals */
function closeModal() {
  document.getElementById('modalBackdrop').style.display = 'none';
  ['celebrationModal','adminModal','clearAllModal'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  activeModalId = null;

  // Clear password field if closing admin modal
  document.getElementById('adminPwInput').value = '';
  document.getElementById('adminPwError').style.display = 'none';
}

// Close when clicking the dark backdrop itself (not a modal box)
document.getElementById('modalBackdrop').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

/* ====================================================
   DATA PERSISTENCE
   ==================================================== */

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(participants));
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) participants = JSON.parse(raw);
  } catch(e) {
    participants = [];
  }
}

/* ====================================================
   NAME MANAGEMENT (all admin-gated in the UI)
   ==================================================== */

/** Import names from textarea — one per line, deduplicated */
function importNames() {
  const box   = document.getElementById('importBox');
  const lines = box.value.split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0;
  lines.forEach(name => {
    if (!participants.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      participants.push({ name, leaderWins: 0, vipWins: 0 });
      added++;
    }
  });
  box.value = '';
  saveToStorage();
  renderAll();
  if (added === 0) alert('No new names to add (duplicates skipped).');
}

/** Add a single name from the text input */
function addSingleName() {
  const input = document.getElementById('singleName');
  const name  = input.value.trim();
  if (!name) return;
  if (participants.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    alert(`"${name}" is already in the list.`);
    return;
  }
  participants.push({ name, leaderWins: 0, vipWins: 0 });
  input.value = '';
  saveToStorage();
  renderAll();
}

/** Remove one participant by index (admin only — button hidden otherwise) */
function removeName(index) {
  const name = participants[index]?.name || 'this person';
  if (!confirm(`Remove "${name}" from the list?`)) return;
  participants.splice(index, 1);
  saveToStorage();
  renderAll();
}

function clearImportBox() {
  document.getElementById('importBox').value = '';
}

/** Reset all win counts to zero */
function resetStats() {
  if (!confirm('Reset all win counts to zero? Odds will equalise. This cannot be undone.')) return;
  participants.forEach(p => { p.leaderWins = 0; p.vipWins = 0; });
  currentRound = { leaderWinner: null, vipWinner: null };
  saveToStorage();
  renderAll();
  setStatus('Stats reset — equal odds restored.');
}

/** Open confirm-clear modal (lists all names before deleting) */
function confirmClearAll() {
  const listEl = document.getElementById('clearAllNameList');
  if (participants.length === 0) {
    alert('There are no participants to clear.');
    return;
  }
  // Populate the name list inside the confirmation modal
  listEl.innerHTML = participants
    .map(p => `<div>${escapeHtml(p.name)}</div>`)
    .join('');
  openModal('clearAllModal');
}

/** Actually delete everything — called by the confirm button */
function executeClearAll() {
  participants = [];
  currentRound = { leaderWinner: null, vipWinner: null };
  saveToStorage();
  closeModal();
  renderAll();
  setStatus('All cleared.');
}

/* ====================================================
   WEIGHTED RANDOM SELECTION
   w(p) = 1 / (1 + totalWins)
   0 wins → 1.0,  1 win → 0.5,  2 wins → 0.33 …
   Never zero — repeat wins possible but increasingly rare.
   ==================================================== */

function weightOf(p) {
  return 1 / (1 + p.leaderWins + p.vipWins);
}

function weightedPick(pool) {
  const weights = pool.map(weightOf);
  const total   = weights.reduce((a, b) => a + b, 0);
  let rand      = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return pool[i];
  }
  return pool[pool.length - 1]; // floating-point fallback
}

/* ====================================================
   SPINNING LOGIC
   ==================================================== */

function spinFor(role) {
  if (isSpinning) return;
  if (participants.length < 2) {
    alert('Please add at least 2 participants first.');
    return;
  }

  let pool = [...participants];
  if (role === 'vip' && currentRound.leaderWinner) {
    pool = pool.filter(p => p.name !== currentRound.leaderWinner);
  }

  if (pool.length === 0) {
    alert('Not enough participants for this spin.');
    return;
  }

  const winner = weightedPick(pool);
  isSpinning   = true;
  disableButtons(true);
  setStatus(`Spinning for ${role === 'leader' ? '🧭 Caravan Leader' : '🛡️ VIP / Guard'}…`);

  animateWheel(pool, winner, () => {
    isSpinning = false;

    if (role === 'leader') {
      currentRound.leaderWinner = winner.name;
      winner.leaderWins++;
      setStatus(`🧭 Caravan Leader: ${winner.name} — now spin for VIP/Guard!`);
      highlightName(winner.name, 'leader');
      document.getElementById('btnLeader').disabled = true;
      document.getElementById('btnVip').disabled    = false;
    } else {
      currentRound.vipWinner = winner.name;
      winner.vipWins++;
      setStatus(`🛡️ VIP/Guard: ${winner.name} — round complete!`);
      highlightName(winner.name, 'vip');
      setTimeout(showCelebrationModal, 400);
      document.getElementById('btnLeader').disabled = false;
      document.getElementById('btnVip').disabled    = true;
    }

    saveToStorage();
    renderNameList();
  });
}

/* ====================================================
   WHEEL ANIMATION
   ==================================================== */

function animateWheel(pool, winner, onDone) {
  const totalWeight   = pool.reduce((s, p) => s + weightOf(p), 0);
  const segmentAngles = pool.map(p => (weightOf(p) / totalWeight) * Math.PI * 2);

  const winnerIdx = pool.indexOf(winner);
  let accumulated = 0;
  for (let i = 0; i < winnerIdx; i++) accumulated += segmentAngles[i];
  const segMid = accumulated + segmentAngles[winnerIdx] / 2;

  const extraSpins  = 5 + Math.floor(Math.random() * 3);
  const targetAngle = extraSpins * Math.PI * 2 + (-Math.PI / 2 - segMid);
  const duration    = 4000;
  const startTime   = performance.now();

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function frame(now) {
    const t     = Math.min((now - startTime) / duration, 1);
    const angle = targetAngle * easeOut(t);
    drawWheel(pool, segmentAngles, angle);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      drawWheel(pool, segmentAngles, targetAngle);
      disableButtons(false);
      onDone();
    }
  }

  requestAnimationFrame(frame);
}

function drawWheel(pool, segmentAngles, rotation) {
  const W  = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const r  = Math.min(cx, cy) - 4;

  ctx.clearRect(0, 0, W, H);

  let start = rotation;
  pool.forEach((p, i) => {
    const end   = start + segmentAngles[i];
    const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const mid      = start + (end - start) / 2;
    const labelR   = r * 0.68;
    const lx       = cx + Math.cos(mid) * labelR;
    const ly       = cy + Math.sin(mid) * labelR;
    const maxChars = Math.max(6, Math.floor(360 / pool.length / 6));
    const label    = p.name.length > maxChars ? p.name.slice(0, maxChars - 1) + '…' : p.name;

    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(mid + Math.PI / 2);
    ctx.fillStyle    = '#fff';
    ctx.font         = `bold ${Math.max(9, Math.min(14, 280 / pool.length))}px Lato, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur   = 3;
    ctx.fillText(label, 0, 0);
    ctx.restore();

    start = end;
  });

  // Center hub
  ctx.beginPath();
  ctx.arc(cx, cy, 24, 0, Math.PI * 2);
  ctx.fillStyle   = '#1a1208';
  ctx.fill();
  ctx.strokeStyle = '#d4952a';
  ctx.lineWidth   = 3;
  ctx.stroke();
  ctx.font         = '18px serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🏕️', cx, cy);
}

/* ====================================================
   RENDER / UI HELPERS
   ==================================================== */

function renderAll() {
  renderNameList();
  if (participants.length > 0) {
    const total  = participants.reduce((s, p) => s + weightOf(p), 0);
    const angles = participants.map(p => (weightOf(p) / total) * Math.PI * 2);
    drawWheel(participants, angles, 0);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle    = '#5a3e1b';
    ctx.font         = '14px Lato, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Add names to see the wheel', canvas.width / 2, canvas.height / 2);
  }
  document.getElementById('nameCount').textContent = participants.length;
}

function renderNameList() {
  const list = document.getElementById('nameList');
  list.innerHTML = '';

  if (participants.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem 0">No participants yet.</p>';
    return;
  }

  const totalWeight = participants.reduce((s, p) => s + weightOf(p), 0);

  participants.forEach((p, idx) => {
    const oddsPercent = ((weightOf(p) / totalWeight) * 100).toFixed(1);

    const row = document.createElement('div');
    row.className = 'name-row';
    row.id = `row-${idx}`;

    row.innerHTML = `
      <span class="name-text" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
      <span class="win-badges">
        <span class="win-pill leader" title="Caravan Leader wins">🧭 ${p.leaderWins}</span>
        <span class="win-pill vip"    title="VIP/Guard wins">🛡️ ${p.vipWins}</span>
      </span>
      <button class="del-btn" onclick="removeName(${idx})" title="Remove ${escapeHtml(p.name)}">✕</button>
      <div class="odds-bar-wrap">
        <div class="odds-bar-fill" style="width:${oddsPercent}%"></div>
      </div>
    `;

    list.appendChild(row);
  });

  document.getElementById('nameCount').textContent = participants.length;
}

function highlightName(name, role) {
  const idx = participants.findIndex(p => p.name === name);
  if (idx === -1) return;
  const row = document.getElementById(`row-${idx}`);
  if (!row) return;
  row.classList.add(`highlight-${role}`);
  setTimeout(() => row.classList.remove(`highlight-${role}`), 3000);
}

function setStatus(msg) {
  document.getElementById('spinStatus').textContent = msg;
}

function disableButtons(state) {
  document.getElementById('btnLeader').disabled = state;
  document.getElementById('btnVip').disabled    = state;
}

/** Show the celebration modal with this round's winners */
function showCelebrationModal() {
  document.getElementById('modalLeader').textContent = currentRound.leaderWinner || '—';
  document.getElementById('modalVip').textContent    = currentRound.vipWinner    || '—';
  openModal('celebrationModal');
  // Reset round state after populating display
  currentRound = { leaderWinner: null, vipWinner: null };
}

function escapeHtml(str) {
  return str
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
