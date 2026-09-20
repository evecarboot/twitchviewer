/*
 * Startup safety regression: a second TwitchViewer on an occupied port must
 * fail clearly (friendly EADDRINUSE message + nonzero exit), not crash with a
 * raw Node stack trace and not keep running silently.
 *
 * Spawns real `node server.js` child processes — server.js starts listening at
 * require time and cannot be unit-tested in-process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PORT = 34771; // uncommon port to avoid colliding with a real instance

function spawnServer(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TWITCH_PLAYBACK: 'proxy' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, output: () => out };
}

function waitFor(pred, getOutput, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (pred(getOutput())) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(iv);
        reject(new Error('timed out; server output:\n' + getOutput()));
      }
    }, 150);
  });
}

test('second instance on the same port exits clearly with EADDRINUSE guidance', async () => {
  const a = spawnServer(TEST_PORT);
  try {
    await waitFor((o) => o.includes('Twitch viewer ('), a.output);

    const b = spawnServer(TEST_PORT);
    const exitCode = await new Promise((res) => b.child.on('exit', res));
    const out = b.output();
    assert.equal(exitCode, 1, 'second instance must exit nonzero');
    assert.match(out, /already in use/i, 'must say the port is taken');
    assert.match(out, /TwitchViewer could not start/i);
    assert.doesNotMatch(out, /at \w+\.js:\d+/i, 'must not be a raw stack trace');
  } finally {
    a.child.kill('SIGKILL');
  }
});

test('startup log identifies PID, port, and playback mode', async () => {
  const a = spawnServer(TEST_PORT + 1);
  try {
    await waitFor((o) => o.includes('PID:'), a.output);
    const out = a.output();
    assert.match(out, /PID: \d+/);
    assert.match(out, /Port: \d+/);
    assert.match(out, /Twitch playback mode: proxy/);
  } finally {
    a.child.kill('SIGKILL');
  }
});

/* Diagnostic exports prove which backend the browser was talking to — the
   /api/status payload must carry safe server identity (pid, port, build,
   actual playback mode) without ever leaking env vars or paths. */
test('/api/status exposes safe server identity for diagnostics', async () => {
  const port = TEST_PORT + 2;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), USE_HTTP: 'true', TWITCH_PLAYBACK: 'proxy' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    await waitFor((o) => o.includes('Twitch viewer ('), () => out);
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.twitchPlayback, 'proxy', 'must report the actual mode');
    assert.equal(body.pid, child.pid, 'pid must match the spawned process');
    assert.equal(body.port, port, 'port must match the listening port');
    assert.equal(typeof body.buildCommit, 'string');
    assert.ok(body.buildCommit.length > 0, 'buildCommit resolves or reports unknown');
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /TWITCH_CLIENT_SECRET|SECRET|PASSWORD/i, 'no secret material');
    assert.doesNotMatch(text, /[A-Z]:\\\\|\/Users\//i, 'no filesystem paths');
  } finally {
    child.kill('SIGKILL');
  }
});
