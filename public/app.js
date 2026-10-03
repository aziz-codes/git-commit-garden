const $ = (id) => document.getElementById(id);

const PHASE_LABELS = {
  idle: 'Idle',
  setup: 'Setting up repo',
  changing: 'Changing file',
  committing: 'Committing',
  pushing: 'Pushing',
  waiting: 'Waiting',
  done: 'Finished',
  error: 'Error',
};

const ICONS = { info: '•', success: '✓', change: '✎', commit: '◆', push: '↑', warn: '!', error: '✕' };
const GRAPH_WEEKS = 53;

let state = null;
let prevFileTail = [];

// ---------------- Form ----------------

const form = $('form');
const modeInputs = form.querySelectorAll('input[name="mode"]');

function currentMode() {
  return form.querySelector('input[name="mode"]:checked').value;
}

function syncModeFields() {
  const mode = currentMode();
  form.querySelectorAll('[data-for]').forEach((el) => el.classList.toggle('hidden', el.dataset.for !== mode));
  // Backfill commits are batched, live pushes after every commit by default.
  if (mode === 'backfill' && $('pushEvery').value === '1') $('pushEvery').value = '25';
  if (mode === 'live' && $('pushEvery').value === '25') $('pushEvery').value = '1';
}
modeInputs.forEach((el) => el.addEventListener('change', syncModeFields));

try {
  const saved = localStorage.getItem('commit-garden:repo');
  if (saved) $('repoUrl').value = saved;
} catch {}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('hint').textContent = '';
  const repoUrl = $('repoUrl').value.trim();
  try { localStorage.setItem('commit-garden:repo', repoUrl); } catch {}

  const mode = currentMode();
  const body = {
    repoUrl,
    mode,
    interval: mode === 'live' ? $('interval').value : 0,
    maxCommits: $('maxCommits').value,
    pushEvery: $('pushEvery').value,
    days: $('days').value,
    maxPerDay: $('maxPerDay').value,
    density: $('density').value,
  };

  $('startBtn').disabled = true;
  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);

  if (!res || !res.ok) {
    const data = res ? await res.json().catch(() => ({})) : {};
    $('hint').textContent = data.error || 'Could not reach the server.';
    $('startBtn').disabled = false;
  }
});

$('stopBtn').addEventListener('click', () => fetch('/api/stop', { method: 'POST' }));
$('clearLog').addEventListener('click', () => ($('log').innerHTML = ''));

// ---------------- Rendering ----------------

function setNumber(id, value) {
  const el = $(id);
  const text = String(value);
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function render() {
  if (!state) return;
  const { phase, running } = state;

  const status = $('status');
  status.className = 'status' + (running ? ' active' : phase === 'error' ? ' error' : phase === 'done' ? ' done' : '');
  $('statusText').textContent = PHASE_LABELS[phase] || phase;

  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
  form.querySelectorAll('input').forEach((el) => (el.disabled = running));

  setNumber('statCommits', state.totalCommits);
  setNumber('statPushed', state.pushedCommits);
  setNumber('statPending', state.totalCommits - state.pushedCommits);

  document.querySelectorAll('#steps li').forEach((li) => li.classList.toggle('active', running && li.dataset.phase === phase));

  $('metaRepo').textContent = state.repoName || '—';
  $('metaBranch').textContent = state.branch || '—';
  $('metaLast').textContent = state.lastCommit ? `${state.lastCommit.hash} ${state.lastCommit.message}` : '—';
  $('metaLast').title = $('metaLast').textContent;
  $('metaAuthor').textContent = state.gitUser.email || 'not configured';
  $('metaAuthor').title = 'Commits only count on your graph if this email is verified on your GitHub account';

  renderFile();
  renderGraph();
}

function renderFile() {
  const tail = state.fileTail || [];
  if (!tail.length) return;
  const pre = $('file');
  pre.innerHTML = '';
  const isNew = tail[tail.length - 1] !== prevFileTail[prevFileTail.length - 1];
  tail.forEach((line, i) => {
    const span = document.createElement('div');
    span.textContent = line;
    if (isNew && i === tail.length - 1 && prevFileTail.length) span.className = 'new';
    pre.appendChild(span);
  });
  prevFileTail = tail;
}

function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildGraph() {
  const graph = $('graph');
  graph.innerHTML = '';
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (GRAPH_WEEKS - 1) * 7);
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const cell = document.createElement('i');
    cell.dataset.day = dayKey(d);
    cell.title = `No commits on ${cell.dataset.day}`;
    graph.appendChild(cell);
  }
  graph.parentElement.scrollLeft = graph.scrollWidth;
}

function renderGraph() {
  const counts = state.dayCounts || {};
  const max = Math.max(1, ...Object.values(counts));
  document.querySelectorAll('#graph i').forEach((cell) => {
    const n = counts[cell.dataset.day] || 0;
    const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
    cell.style.background = `var(--g${level})`;
    cell.title = `${n || 'No'} commit${n === 1 ? '' : 's'} on ${cell.dataset.day}`;
  });
}

function addLog(entry) {
  const list = $('log');
  const li = document.createElement('li');
  li.className = entry.level;
  const time = new Date(entry.time).toLocaleTimeString([], { hour12: false });
  li.innerHTML = `<time></time><span class="icon"></span><span class="msg"></span>`;
  li.querySelector('time').textContent = time;
  li.querySelector('.icon').textContent = ICONS[entry.level] || '•';
  li.querySelector('.msg').textContent = entry.message;
  list.prepend(li);
  while (list.children.length > 300) list.lastChild.remove();
}

function tickElapsed() {
  if (!state || !state.startedAt) return;
  const end = state.running ? Date.now() : state._endedAt || Date.now();
  const s = Math.max(0, Math.floor((end - new Date(state.startedAt)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  $('statElapsed').textContent = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
setInterval(tickElapsed, 1000);

// ---------------- Live updates ----------------

buildGraph();

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    $('log').innerHTML = '';
    data.logs.forEach(addLog);
    state = data.state;
    render();
    tickElapsed();
  });
  es.addEventListener('state', (e) => {
    const wasRunning = state && state.running;
    state = JSON.parse(e.data);
    if (wasRunning && !state.running) state._endedAt = Date.now();
    render();
  });
  es.addEventListener('log', (e) => addLog(JSON.parse(e.data)));
  es.onerror = () => {
    $('statusText').textContent = 'Reconnecting…';
  };
}
connect();
