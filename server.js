const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACES_DIR = path.join(__dirname, 'workspaces');
const TEST_FILE = 'test.txt';
const START_PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  running: false,
  phase: 'idle', // idle | setup | changing | committing | pushing | waiting | done | error
  repoUrl: null,
  repoName: null,
  branch: null,
  workDir: null,
  mode: 'live',
  settings: {},
  totalCommits: 0,
  pushedCommits: 0,
  pushes: 0,
  failedPushes: 0,
  startedAt: null,
  lastCommit: null,
  dayCounts: {}, // YYYY-MM-DD -> commits made this session
  fileTail: [],
  gitUser: { name: null, email: null },
  error: null,
};

const logs = [];
const clients = new Set();
let stopRequested = false;
let wakeUp = null;

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function log(level, message) {
  const entry = { time: new Date().toISOString(), level, message };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  broadcast('log', entry);
  console.log(`[${level}] ${message}`);
}

function setPhase(phase) {
  state.phase = phase;
  pushState();
}

function pushState() {
  broadcast('state', state);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args, { cwd = state.workDir, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        // Never block waiting for a username/password prompt in the terminal.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.message = (stderr || stdout || err.message).trim();
          return reject(err);
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function readGitUser() {
  const get = (key) => git(['config', '--get', key], { cwd: __dirname }).catch(() => null);
  state.gitUser = { name: await get('user.name'), email: await get('user.email') };
}

function parseRepo(input) {
  const raw = String(input || '').trim();
  let m = raw.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return { url: raw, owner: m[1], repo: m[2] };
  m = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return { url: `https://github.com/${m[1]}/${m[2]}.git`, owner: m[1], repo: m[2] };
  m = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (m) return { url: `https://github.com/${m[1]}/${m[2]}.git`, owner: m[1], repo: m[2] };
  return null;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const MESSAGES = [
  'Update test file',
  'Tweak content',
  'Refresh notes',
  'Small improvement',
  'Polish wording',
  'Add new entry',
  'Routine update',
  'Keep things fresh',
];

const LINES = [
  'Small steps every day.',
  'Consistency beats intensity.',
  'Ship it, then iterate.',
  'Green squares, happy dev.',
  'Code, commit, repeat.',
  'Progress over perfection.',
  'One more commit for the garden.',
  'Keep the streak alive.',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const dayKey = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Git's internal date format ("<unix seconds> <+hhmm>") keeps the local timezone.
function gitDate(d) {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  const tz = `${off >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `${Math.floor(d.getTime() / 1000)} ${tz}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeUp = () => {
      clearTimeout(t);
      resolve();
    };
  });
}

function refreshFileTail() {
  try {
    const content = fs.readFileSync(path.join(state.workDir, TEST_FILE), 'utf8');
    state.fileTail = content.trimEnd().split('\n').slice(-8);
  } catch {
    state.fileTail = [];
  }
}

async function setupRepo(repo) {
  setPhase('setup');
  state.workDir = path.join(WORKSPACES_DIR, `${repo.owner}__${repo.repo}`);
  fs.mkdirSync(state.workDir, { recursive: true });

  if (!fs.existsSync(path.join(state.workDir, '.git'))) {
    log('info', `Initializing git repository in workspaces/${path.basename(state.workDir)}`);
    await git(['init']);
  } else {
    log('info', 'Reusing existing local workspace');
  }

  const filePath = path.join(state.workDir, TEST_FILE);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Commit Garden\n# Created ${new Date().toISOString()}\n`);
    log('success', `Created ${TEST_FILE}`);
  }

  const remotes = (await git(['remote'])).split('\n').filter(Boolean);
  if (remotes.includes('origin')) {
    await git(['remote', 'set-url', 'origin', repo.url]);
    log('info', `Updated remote origin → ${repo.url}`);
  } else {
    await git(['remote', 'add', 'origin', repo.url]);
    log('success', `Added remote origin → ${repo.url}`);
  }

  log('info', 'Checking remote repository…');
  let remoteRefs = '';
  try {
    remoteRefs = await git(['ls-remote', '--symref', 'origin']);
  } catch (err) {
    throw new Error(`Cannot reach remote: ${err.message}`);
  }

  const heads = [...remoteRefs.matchAll(/^\S+\s+refs\/heads\/(\S+)$/gm)].map((m) => m[1]);
  const headSymref = remoteRefs.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m);
  const remoteBranch = [headSymref && headSymref[1], 'main', 'master', heads[0]].find((b) => b && heads.includes(b));
  if (remoteBranch) {
    // Remote already has commits: build on top of its default branch.
    state.branch = remoteBranch;
    log('info', `Remote has history on "${state.branch}", fetching…`);
    await git(['fetch', 'origin', state.branch]);
    await git(['checkout', '-f', '-B', state.branch, `origin/${state.branch}`]);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, `# Commit Garden\n# Created ${new Date().toISOString()}\n`);
      log('success', `Created ${TEST_FILE}`);
    }
  } else {
    state.branch = 'main';
    log('info', 'Remote is empty, using branch "main"');
    await git(['checkout', '-B', state.branch]).catch(() => git(['symbolic-ref', 'HEAD', `refs/heads/${state.branch}`]));
  }

  refreshFileTail();
  pushState();
}

async function makeCommit(date) {
  setPhase('changing');
  const when = date || new Date();
  const line = `${when.toLocaleString('sv-SE')}  ${pick(LINES)}\n`;
  fs.appendFileSync(path.join(state.workDir, TEST_FILE), line);
  refreshFileTail();
  log('change', `Appended to ${TEST_FILE}: "${line.trim()}"`);

  setPhase('committing');
  const message = `${pick(MESSAGES)} #${state.totalCommits + 1}`;
  const env = date ? { GIT_AUTHOR_DATE: gitDate(date), GIT_COMMITTER_DATE: gitDate(date) } : {};
  await git(['add', TEST_FILE]);
  await git(['commit', '-m', message], { env });
  const hash = await git(['rev-parse', '--short', 'HEAD']);

  state.totalCommits++;
  const key = dayKey(when);
  state.dayCounts[key] = (state.dayCounts[key] || 0) + 1;
  state.lastCommit = { hash, message, time: when.toISOString() };
  log('commit', `[${hash}] ${message}`);
  pushState();
}

async function push() {
  const pending = state.totalCommits - state.pushedCommits;
  if (pending <= 0) return;
  setPhase('pushing');
  log('info', `Pushing ${pending} commit(s) to origin/${state.branch}…`);
  try {
    await git(['push', '-u', 'origin', state.branch]);
  } catch (err) {
    if (/rejected|non-fast-forward|fetch first/i.test(err.message)) {
      log('warn', 'Push rejected, rebasing on remote and retrying…');
      try {
        // Our commits only append to test.txt, so prefer our side on conflicts.
        await git(['pull', '--rebase', '-X', 'theirs', 'origin', state.branch]);
      } catch (rebaseErr) {
        await git(['rebase', '--abort']).catch(() => {});
        state.failedPushes++;
        throw new Error(`Could not sync with remote: ${rebaseErr.message.split('\n').pop()}`);
      }
      await git(['push', '-u', 'origin', state.branch]);
    } else {
      state.failedPushes++;
      throw err;
    }
  }
  state.pushes++;
  state.pushedCommits = state.totalCommits;
  log('push', `Pushed successfully (${state.pushedCommits} total pushed)`);
  pushState();
}

async function runLive(s) {
  while (!stopRequested && (s.maxCommits === 0 || state.totalCommits < s.maxCommits)) {
    await makeCommit();
    if ((state.totalCommits - state.pushedCommits) >= s.pushEvery) await push();
    if (stopRequested || (s.maxCommits && state.totalCommits >= s.maxCommits)) break;
    setPhase('waiting');
    await sleep(s.interval * 1000);
  }
}

async function runBackfill(s) {
  const today = new Date();
  for (let offset = s.days - 1; offset >= 0 && !stopRequested; offset--) {
    if (Math.random() * 100 >= s.density) continue; // leave some days empty so it looks natural
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const count = randInt(1, s.maxPerDay);
    log('info', `${dayKey(day)}: making ${count} commit(s)`);
    for (let i = 0; i < count && !stopRequested; i++) {
      const date = new Date(day);
      date.setHours(randInt(9, 22), randInt(0, 59), randInt(0, 59), 0);
      if (date > new Date()) {
        // Today: pick a moment between midnight and now.
        const midnight = new Date(day).setHours(0, 0, 0, 0);
        date.setTime(midnight + Math.random() * (Date.now() - midnight));
      }
      await makeCommit(date);
      if ((state.totalCommits - state.pushedCommits) >= s.pushEvery) await push();
      if (s.interval > 0) await sleep(s.interval * 1000);
    }
  }
}

async function run(repo, settings) {
  stopRequested = false;
  Object.assign(state, {
    running: true,
    error: null,
    repoUrl: repo.url,
    repoName: `${repo.owner}/${repo.repo}`,
    mode: settings.mode,
    settings,
    totalCommits: 0,
    pushedCommits: 0,
    pushes: 0,
    failedPushes: 0,
    startedAt: new Date().toISOString(),
    lastCommit: null,
    dayCounts: {},
  });
  log('info', `Starting ${settings.mode} mode for ${state.repoName}`);

  try {
    await readGitUser();
    if (!state.gitUser.email) throw new Error('git user.email is not set. Run: git config --global user.email "you@example.com"');
    await setupRepo(repo);
    if (settings.mode === 'backfill') await runBackfill(settings);
    else await runLive(settings);
    await push();
    setPhase('done');
    log('success', stopRequested ? 'Stopped by user' : `Finished: ${state.totalCommits} commit(s) made`);
  } catch (err) {
    state.error = err.message;
    log('error', err.message);
    if (/auth|permission|denied|403|could not read Username/i.test(err.message)) {
      log('warn', 'Authentication failed. Make sure git can push to this repo (SSH key or credential helper / `gh auth login`).');
    }
    setPhase('error');
  } finally {
    state.running = false;
    pushState();
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const clamp = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: init\ndata: ${JSON.stringify({ state, logs })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    if (state.running) return json(res, 409, { error: 'Already running' });
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const repo = parseRepo(body.repoUrl);
    if (!repo) return json(res, 400, { error: 'Enter a valid GitHub repo URL, e.g. https://github.com/user/repo' });
    const mode = body.mode === 'backfill' ? 'backfill' : 'live';
    const settings = {
      mode,
      interval: clamp(body.interval, mode === 'backfill' ? 0 : 1, 86400, mode === 'backfill' ? 0 : 10),
      maxCommits: clamp(body.maxCommits, 0, 100000, 0),
      pushEvery: clamp(body.pushEvery, 1, 1000, mode === 'backfill' ? 25 : 1),
      days: clamp(body.days, 1, 366, 90),
      maxPerDay: clamp(body.maxPerDay, 1, 50, 5),
      density: clamp(body.density, 1, 100, 80),
    };
    run(repo, settings);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    if (!state.running) return json(res, 409, { error: 'Not running' });
    stopRequested = true;
    log('warn', 'Stop requested, finishing current step…');
    if (wakeUp) wakeUp();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET') {
    const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
    return fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  json(res, 404, { error: 'Not found' });
});

// Keep SSE connections alive through proxies.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 20000);

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* ignore: user can open the URL manually */
  }
}

function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < START_PORT + 20) return listen(port + 1);
    throw err;
  });
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://localhost:${port}`;
    await readGitUser();
    console.log(`\n  🌱 Commit Garden running at ${url}\n`);
    openBrowser(url);
  });
}

listen(START_PORT);
