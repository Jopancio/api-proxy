// Process supervisor for server.js and telegram-bot.js.
//
// Runs in the FOREGROUND and never exits on its own, so hosting providers that
// treat "main process exited" as "service stopped" keep the services alive.
// Each service is restarted automatically (with backoff) whenever it crashes or
// exits. Child stdout/stderr is streamed line-by-line, with a timestamp and
// service prefix, to this process's console (what the host panel shows) AND
// appended to the per-service log files.
//
// Usage:
//   node start-services.js           foreground supervisor (use on hosting)
//   node start-services.js --detach  launch the supervisor in the background
//                                    and return (local convenience)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectDir = __dirname;
const runtimeDir = path.join(projectDir, '.runtime');
const supervisorLogPath = path.join(projectDir, 'start-services.log');

const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30000;
// A child that stays up this long is considered healthy; its backoff resets.
const STABLE_AFTER_MS = 60000;
const SHUTDOWN_GRACE_MS = 10000;

const SERVICES = [
  { name: 'server', script: 'server.js', outputLog: 'server.out.log', errorLog: 'server.err.log' },
  { name: 'telegram-bot', script: 'telegram-bot.js', outputLog: 'telegram.out.log', errorLog: 'telegram.err.log' },
];

// Never crash the supervisor because the console pipe went away.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

let supervisorLog = null;

function timestamp() {
  return new Date().toISOString();
}

function log(message, isError = false) {
  const line = `${timestamp()} [supervisor] ${message}\n`;
  (isError ? process.stderr : process.stdout).write(line);
  if (supervisorLog) supervisorLog.write(line);
}

function pidPath(name) {
  return path.join(runtimeDir, `${name}.pid`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return !isAlive(pid);
}

// Stops a process recorded by a previous run (old detached children or an
// older supervisor) so the bot never ends up polling twice.
async function stopTrackedProcess(name) {
  const file = pidPath(name);
  if (!fs.existsSync(file)) return;

  const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  // After a container restart PIDs are reused; a stale file could point at
  // this very process or its launcher.
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== process.ppid && isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      if (!(await waitForExit(pid, SHUTDOWN_GRACE_MS + 2000))) {
        process.kill(pid, 'SIGKILL');
        await waitForExit(pid, 2000);
      }
      log(`Stopped previous ${name} process (PID ${pid}).`);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  fs.rmSync(file, { force: true });
}

// Streams a child pipe to the console and a log file, one prefixed line at a time.
function pipeLines(stream, name, fileStream, toStderr) {
  let buffered = '';
  const emit = (text) => {
    const line = `${timestamp()} [${name}] ${text}\n`;
    (toStderr ? process.stderr : process.stdout).write(line);
    fileStream.write(line);
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const text of lines) emit(text);
  });
  stream.on('end', () => {
    if (buffered) emit(buffered);
    buffered = '';
  });
}

const state = new Map(SERVICES.map((service) => [
  service.name,
  { child: null, timer: null, startedAt: 0, restartDelay: RESTART_MIN_MS },
]));
let shuttingDown = false;

function startService(service) {
  const s = state.get(service.name);
  s.timer = null;
  if (shuttingDown) return;

  const outFile = fs.createWriteStream(path.join(projectDir, service.outputLog), { flags: 'a' });
  const errFile = fs.createWriteStream(path.join(projectDir, service.errorLog), { flags: 'a' });
  const child = spawn(process.execPath, [service.script], {
    cwd: projectDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.child = child;
  s.startedAt = Date.now();

  if (child.pid) {
    fs.writeFileSync(pidPath(service.name), String(child.pid));
    log(`${service.name} started (PID ${child.pid}).`);
  }
  pipeLines(child.stdout, service.name, outFile, false);
  pipeLines(child.stderr, service.name, errFile, true);

  let finished = false;
  const onFinished = (code, signal, spawnError) => {
    if (finished) return;
    finished = true;
    outFile.end();
    errFile.end();
    s.child = null;
    fs.rmSync(pidPath(service.name), { force: true });

    if (shuttingDown) {
      log(`${service.name} stopped.`);
      return;
    }

    const ranFor = Date.now() - s.startedAt;
    if (ranFor >= STABLE_AFTER_MS) s.restartDelay = RESTART_MIN_MS;
    const reason = spawnError
      ? `failed to start: ${spawnError.message}`
      : `exited with ${signal ? `signal ${signal}` : `code ${code}`} after ${Math.round(ranFor / 1000)}s`;
    log(`${service.name} ${reason}; restarting in ${s.restartDelay / 1000}s.`, true);
    s.timer = setTimeout(() => startService(service), s.restartDelay);
    s.restartDelay = Math.min(s.restartDelay * 2, RESTART_MAX_MS);
  };

  child.on('error', (error) => {
    // Without a pid the process never started and 'close' may not follow.
    if (!child.pid) onFinished(null, null, error);
    else log(`${service.name} process error: ${error.message}`, true);
  });
  child.on('close', (code, signal) => onFinished(code, signal));
}

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (${reason})...`);

  const pending = [];
  for (const s of state.values()) {
    if (s.timer) clearTimeout(s.timer);
    if (s.child) {
      const child = s.child;
      pending.push(new Promise((resolve) => child.once('close', resolve)));
      child.kill('SIGTERM');
    }
  }

  const forceKill = setTimeout(() => {
    for (const s of state.values()) if (s.child) s.child.kill('SIGKILL');
  }, SHUTDOWN_GRACE_MS);
  // Last resort so a stuck child can never keep the supervisor alive forever.
  setTimeout(() => process.exit(exitCode), SHUTDOWN_GRACE_MS + 5000).unref();

  Promise.all(pending).then(() => {
    clearTimeout(forceKill);
    fs.rmSync(pidPath('supervisor'), { force: true });
    log('All services stopped.');
    supervisorLog.end(() => process.exit(exitCode));
  });
}

function detach() {
  const child = spawn(process.execPath, [__filename], {
    cwd: projectDir,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`Supervisor started in the background (PID ${child.pid}).`);
  console.log('Logs: start-services.log, server.*.log, telegram.*.log');
}

async function main() {
  if (process.argv.includes('--detach')) {
    detach();
    return;
  }

  fs.mkdirSync(runtimeDir, { recursive: true });
  supervisorLog = fs.createWriteStream(supervisorLogPath, { flags: 'a' });

  // Stop an older supervisor first so it cannot respawn the children we stop next.
  await stopTrackedProcess('supervisor');
  for (const service of SERVICES) await stopTrackedProcess(service.name);

  fs.writeFileSync(pidPath('supervisor'), String(process.pid));
  log(`Supervisor running (PID ${process.pid}).`);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => shutdown(signal));
  }
  process.on('uncaughtException', (error) => {
    log(`Uncaught exception: ${error.stack || error.message}`, true);
    shutdown('uncaught exception', 1);
  });

  for (const service of SERVICES) startService(service);
  log('Both services are running; they will be restarted automatically if they exit.');
}

main().catch((error) => {
  log(`Startup failed: ${error.stack || error.message}`, true);
  process.exit(1);
});
