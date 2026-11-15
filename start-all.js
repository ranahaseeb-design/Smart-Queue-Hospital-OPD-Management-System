#!/usr/bin/env node
/**
 * Smart OPD — one command for the whole local stack:  npm run dev   (Git Bash, PowerShell, cmd,
 * macOS / Linux shells). No admin rights needed.
 *
 *   [MONGO]     MongoDB on 127.0.0.1:27017 as replica set rs0 (needed for transactions):
 *               reuses a running server; otherwise tries the Windows "MongoDB" service, then starts
 *               mongod itself (detached, so it keeps running after Ctrl+C); initialises rs0 once.
 *   [AI]        FastAPI AI service (Random Forest) on :8000 — ai-service/.venv or venv if present,
 *               else the system Python. Optional: the backend falls back to Eq. 6.2 without it.
 *   [BACKEND]   Express + Socket.IO API on :4000 (waits for /api/health).
 *   [FRONTEND]  Smart OPD Dashboard (Vite) on :5174 — every role signs in there.
 *
 * Ctrl+C stops the AI service, backend and dashboard started by this script (MongoDB keeps
 * running). Services that are already running are reused, not started twice.
 *
 * Overrides (environment variables): MONGOD_PATH (mongod executable), MONGO_DBPATH (data folder),
 * MONGO_LOGPATH, PYTHON (python executable), SKIP_AI=1.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const IS_WIN = process.platform === 'win32';
const PORTS = { mongo: 27017, backend: 4000, ai: 8000, frontend: 5174 };
const MONGO_URI_DIRECT = `mongodb://127.0.0.1:${PORTS.mongo}/?directConnection=true`;

// ---------------------------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------------------------
const COLORS = { MONGO: 32, AI: 35, BACKEND: 36, FRONTEND: 33, SETUP: 34, ERROR: 31 };
const useColor = process.stdout.isTTY || process.env.FORCE_COLOR || process.env.TERM;
function tag(name) {
  const label = `[${name}]`.padEnd(11);
  return useColor ? `\x1b[${COLORS[name] || 37}m${label}\x1b[0m` : label;
}
function log(name, message) {
  for (const line of String(message).split(/\r?\n/)) if (line.trim()) process.stdout.write(`${tag(name)} ${line}\n`);
}
const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function httpOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300 ? body || 'ok' : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function waitFor(check, { timeoutMs, intervalMs = 1000 }) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

function readEnv(file) {
  try {
    return Object.fromEntries(
      fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
    );
  } catch {
    return null;
  }
}

function firstExisting(paths) {
  return paths.find((p) => p && fs.existsSync(p)) || null;
}

function onPath(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// ---------------------------------------------------------------------------------------------
// Managed child processes (prefixed output; stopped on Ctrl+C)
// ---------------------------------------------------------------------------------------------
const children = [];

function run(name, command, args, { cwd, env } = {}) {
  // Through the shell so npm / npx (.cmd shims on Windows) resolve the same way in every shell.
  const quoted = [command, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  const child = spawn(quoted, { cwd, env: { ...process.env, FORCE_COLOR: '1', ...env }, shell: true, detached: !IS_WIN, windowsHide: true });
  children.push({ name, child });
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) if (line.trim()) process.stdout.write(`${tag(name)} ${line}\n`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) log(name, `stopped (${signal || `exit code ${code}`})`);
  });
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('SETUP', 'Stopping the AI service, backend and dashboard (MongoDB keeps running)…');
  for (const { child } of children) {
    if (child.exitCode !== null) continue;
    try {
      if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------
function checkDependencies() {
  const missing = ['backend', 'admin-dashboard', 'staff-dashboard'].filter((d) => !fs.existsSync(path.join(ROOT, d, 'node_modules')));
  for (const dir of missing) {
    log('SETUP', `Installing ${dir} dependencies (first run)…`);
    const r = spawnSync('npm install --no-audit --no-fund', { cwd: path.join(ROOT, dir), shell: true, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`npm install failed in ${dir}`);
  }
}

function ensureEnvFiles() {
  const backendEnv = path.join(ROOT, 'backend', '.env');
  if (!fs.existsSync(backendEnv)) {
    log('SETUP', 'backend/.env missing — creating it with npm run setup (random JWT secret and AI token)…');
    const r = spawnSync('npm run setup', { cwd: path.join(ROOT, 'backend'), shell: true, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('npm run setup failed in backend');
  }
  const be = readEnv(backendEnv) || {};
  if (Number(be.PORT || PORTS.backend) !== PORTS.backend) PORTS.backend = Number(be.PORT);

  // CORS: the dashboard origin must be allowed.
  const origins = (be.CORS_ORIGINS || '').split(',').map((s) => s.trim());
  if (be.CORS_ORIGINS && !origins.includes(`http://localhost:${PORTS.frontend}`)) {
    log('SETUP', `Warning: CORS_ORIGINS in backend/.env does not include http://localhost:${PORTS.frontend}`);
  }

  // The AI service must share the backend's AI_SERVICE_TOKEN (otherwise it refuses every request).
  const aiEnv = path.join(ROOT, 'ai-service', '.env');
  const token = be.AI_SERVICE_TOKEN || '';
  if (!fs.existsSync(aiEnv) && token) {
    const example = path.join(ROOT, 'ai-service', '.env.example');
    const base = fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : 'AI_SERVICE_TOKEN=\n';
    fs.writeFileSync(aiEnv, base.replace(/^AI_SERVICE_TOKEN=.*$/m, `AI_SERVICE_TOKEN=${token}`));
    log('SETUP', 'Created ai-service/.env with the backend\'s AI_SERVICE_TOKEN.');
  } else if (token) {
    const ai = readEnv(aiEnv) || {};
    if (!ai.AI_SERVICE_TOKEN) {
      const text = fs.readFileSync(aiEnv, 'utf8');
      fs.writeFileSync(aiEnv, /^AI_SERVICE_TOKEN=.*$/m.test(text) ? text.replace(/^AI_SERVICE_TOKEN=.*$/m, `AI_SERVICE_TOKEN=${token}`) : `${text}\nAI_SERVICE_TOKEN=${token}\n`);
      log('SETUP', 'Filled AI_SERVICE_TOKEN in ai-service/.env from backend/.env.');
    } else if (ai.AI_SERVICE_TOKEN !== token) {
      log('SETUP', 'Warning: AI_SERVICE_TOKEN differs between backend/.env and ai-service/.env — the backend will treat the AI service as unavailable.');
    }
  }
}

function findMongod() {
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  const home = os.homedir();
  const candidates = [];
  const portable = path.join(home, 'mongodb-portable');
  if (fs.existsSync(portable)) {
    for (const d of fs.readdirSync(portable).filter((n) => n.startsWith('server')).sort().reverse()) {
      candidates.push(path.join(portable, d, 'bin', IS_WIN ? 'mongod.exe' : 'mongod'));
    }
  }
  if (IS_WIN) {
    const pf = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MongoDB', 'Server');
    if (fs.existsSync(pf)) {
      for (const v of fs.readdirSync(pf).sort().reverse()) candidates.push(path.join(pf, v, 'bin', 'mongod.exe'));
    }
  }
  return firstExisting(candidates) || onPath('mongod');
}

function mongoDbPath(mongodPath) {
  if (process.env.MONGO_DBPATH) return process.env.MONGO_DBPATH;
  // The portable install keeps its data next to it (data-9.0, data, …).
  const portable = path.join(os.homedir(), 'mongodb-portable');
  if (mongodPath && mongodPath.startsWith(portable)) {
    const existing = fs.existsSync(portable) ? fs.readdirSync(portable).filter((n) => n.startsWith('data')).sort().reverse() : [];
    if (existing.length) return path.join(portable, existing[0]);
    return path.join(portable, 'data');
  }
  return path.join(ROOT, '.mongodb-data');
}

async function ensureMongo() {
  if (await portOpen(PORTS.mongo)) {
    log('MONGO', `MongoDB already listening on 127.0.0.1:${PORTS.mongo}`);
  } else {
    let started = false;
    if (IS_WIN) {
      // A registered Windows service (installed with the MSI) — may need admin rights; ignore failure.
      const q = spawnSync('sc', ['query', 'MongoDB'], { encoding: 'utf8' });
      if (q.status === 0) {
        log('MONGO', 'Starting the Windows "MongoDB" service…');
        const r = spawnSync('net', ['start', 'MongoDB'], { encoding: 'utf8' });
        started = r.status === 0 || /already been started/i.test(r.stdout + r.stderr);
        if (!started) log('MONGO', 'Could not start the service (admin rights needed?) — starting mongod directly instead.');
      }
    }
    if (!started) {
      const mongod = findMongod();
      if (!mongod) {
        throw new Error('MongoDB is not running and no mongod executable was found. Install MongoDB, or set MONGOD_PATH to mongod(.exe).');
      }
      const dbpath = mongoDbPath(mongod);
      fs.mkdirSync(dbpath, { recursive: true });
      const logpath = process.env.MONGO_LOGPATH || path.join(path.dirname(dbpath), 'log', 'mongod.log');
      fs.mkdirSync(path.dirname(logpath), { recursive: true });
      log('MONGO', `Starting mongod (replica set rs0)\n  binary: ${mongod}\n  data:   ${dbpath}\n  log:    ${logpath}`);
      // Detached: MongoDB keeps running after Ctrl+C / closing Git Bash (other tools use it too).
      const child = spawn(mongod, ['--dbpath', dbpath, '--replSet', 'rs0', '--bind_ip', '127.0.0.1', '--port', String(PORTS.mongo), '--logpath', logpath, '--logappend'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    }
    const up = await waitFor(() => portOpen(PORTS.mongo), { timeoutMs: 45000 });
    if (!up) throw new Error(`MongoDB did not open port ${PORTS.mongo} within 45 s (see its log file).`);
    log('MONGO', `MongoDB is up on 127.0.0.1:${PORTS.mongo}`);
  }
  await ensureReplicaSet();
}

async function ensureReplicaSet() {
  // The MongoDB driver ships with the backend's mongoose.
  const { MongoClient } = require(require.resolve('mongodb', { paths: [path.join(ROOT, 'backend')] }));
  const client = await MongoClient.connect(MONGO_URI_DIRECT, { serverSelectionTimeoutMS: 10000 });
  try {
    const admin = client.db('admin');
    let status = await admin.command({ replSetGetStatus: 1 }).catch((err) => err);
    if (status instanceof Error) {
      if (status.codeName === 'NotYetInitialized' || status.code === 94) {
        log('MONGO', 'Initialising replica set rs0 (first run)…');
        await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${PORTS.mongo}` }] } });
      } else if (status.code === 76 || /not running with --replSet/i.test(status.message)) {
        throw new Error('MongoDB is running WITHOUT a replica set. Add "replication: replSetName: rs0" to mongod.cfg (or start mongod with --replSet rs0) and restart it.');
      } else {
        throw status;
      }
    }
    const primary = await waitFor(async () => {
      const s = await admin.command({ replSetGetStatus: 1 }).catch(() => null);
      return s && s.members && s.members.some((m) => m.stateStr === 'PRIMARY') ? s : null;
    }, { timeoutMs: 30000 });
    if (!primary) throw new Error('Replica set rs0 has no PRIMARY after 30 s.');
    log('MONGO', `Replica set ${primary.set}: PRIMARY ✓`);
  } finally {
    await client.close();
  }
}

function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const ai = path.join(ROOT, 'ai-service');
  const venv = firstExisting(
    ['.venv', 'venv'].map((d) => path.join(ai, d, IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python'))
  );
  if (venv) return venv;
  for (const cmd of IS_WIN ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

async function startAi() {
  if (process.env.SKIP_AI === '1') {
    log('AI', 'Skipped (SKIP_AI=1) — waiting times use the Eq. 6.2 baseline.');
    return;
  }
  if (await httpOk(`http://127.0.0.1:${PORTS.ai}/health`)) {
    log('AI', `AI service already running on :${PORTS.ai} — reusing it.`);
    return;
  }
  const python = findPython();
  if (!python) {
    log('AI', 'Python not found — the AI service is skipped; the backend uses the Eq. 6.2 baseline.');
    return;
  }
  const deps = spawnSync(python, ['-c', 'import fastapi, uvicorn, sklearn, pandas, pymongo, dotenv'], { cwd: path.join(ROOT, 'ai-service'), encoding: 'utf8' });
  if (deps.status !== 0) {
    log('AI', `Python packages missing — run once:  cd ai-service && ${python} -m pip install -r requirements.txt\nThe backend uses the Eq. 6.2 baseline until then.`);
    return;
  }
  log('AI', `Starting the AI service with ${python} on :${PORTS.ai}…`);
  run('AI', python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(PORTS.ai)], { cwd: path.join(ROOT, 'ai-service') });
  const ok = await waitFor(() => httpOk(`http://127.0.0.1:${PORTS.ai}/health`), { timeoutMs: 90000 });
  log('AI', ok ? `AI service ready: ${ok}` : 'AI service did not answer within 90 s — continuing (backend falls back to the baseline).');
}

async function startBackend() {
  const health = `http://127.0.0.1:${PORTS.backend}/api/health`;
  if (await httpOk(health)) {
    log('BACKEND', `Backend already running on :${PORTS.backend} — reusing it.`);
    return;
  }
  if (await portOpen(PORTS.backend)) throw new Error(`Port ${PORTS.backend} is in use by another program (not the Smart OPD backend).`);
  log('BACKEND', `Starting the backend on :${PORTS.backend}…`);
  run('BACKEND', 'npm', ['start'], { cwd: path.join(ROOT, 'backend') });
  const ok = await waitFor(() => httpOk(health), { timeoutMs: 60000 });
  if (!ok) throw new Error('The backend did not answer /api/health within 60 s (see the [BACKEND] lines above).');
  log('BACKEND', `Backend ready: ${ok}`);
}

async function startFrontend() {
  const url = `http://localhost:${PORTS.frontend}`;
  if (await portOpen(PORTS.frontend, 'localhost')) {
    log('FRONTEND', `Dashboard already running on ${url} — reusing it.`);
    return url;
  }
  log('FRONTEND', `Starting the Smart OPD Dashboard (Vite) on :${PORTS.frontend}…`);
  // dev:vite = plain Vite (the folder's own "dev" script points back to this launcher).
  run('FRONTEND', 'npm', ['run', 'dev:vite'], { cwd: path.join(ROOT, 'admin-dashboard') });
  await waitFor(() => portOpen(PORTS.frontend, 'localhost'), { timeoutMs: 60000 });
  return url;
}

async function main() {
  console.log(bold('\nSmart OPD — starting the full stack (MongoDB rs0 · AI :8000 · backend :4000 · dashboard :5174)\n'));
  // npm sets INIT_CWD to the folder `npm run dev` was typed in (root, backend, admin-dashboard, …).
  const from = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : ROOT;
  if (from !== ROOT) log('SETUP', `Started from ${path.relative(ROOT, from) || '.'} — running the whole system from ${ROOT}`);
  checkDependencies();
  ensureEnvFiles();
  await ensureMongo();
  await startAi();
  await startBackend();
  const url = await startFrontend();
  const health = await httpOk(`http://127.0.0.1:${PORTS.backend}/api/health`);
  console.log(
    `\n${bold('Smart OPD is running')}\n`
      + `  Dashboard (all roles):   ${url}\n`
      + `  Waiting-room display:    ${url}/display\n`
      + `  Backend health:          http://localhost:${PORTS.backend}/api/health  ${health || ''}\n`
      + `  AI service:              http://localhost:${PORTS.ai}/health\n`
      + '  Demo logins: admin@opd.test / Admin@123 · doctor1@opd.test / Staff@123 · patient@opd.test / Patient@123\n'
      + '  Press Ctrl+C to stop (MongoDB keeps running).\n'
  );
  if (!children.length) {
    log('SETUP', 'Everything was already running — nothing to supervise. Exiting.');
    process.exit(0);
  }
}

main().catch((err) => {
  log('ERROR', err && err.message ? err.message : String(err));
  shutdown();
  process.exitCode = 1;
});
