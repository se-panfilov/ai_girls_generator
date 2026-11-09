import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  byEnvironmentEntry,
  byUid,
  type Capture,
  collect,
  gpuReleaseState,
  isolationPrefix,
  liveProcesses,
  processProblems,
  reapProcesses,
  RunnerError,
  runOnce,
  type Spawner,
  spawnProcess
} from '@seethrough-bundle/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { loopbackOnly, quietLog, readyWork, sha256, syntheticImage, temporaryDirectory, testHost, writeQualified } from './helpers';

// Stop control of the process tree. The Linux tests start real processes (sh, sleep, setsid) with a random marker in their
// environment, and select only the processes with this marker. They start no model and no See-through code.

const linux = process.platform === 'linux' && existsSync('/proc/self/status');
const markers: string[] = [];

function marker(): string {
  const value = `AIGG_TEST_TREE=${randomBytes(8).toString('hex')}`;
  markers.push(value);
  return value;
}

const markedEnv = (entry: string): Record<string, string> => ({ PATH: '/usr/bin:/bin', [entry.split('=')[0] ?? '']: entry.split('=')[1] ?? '' });
const alive = (entry: string): number[] => liveProcesses().filter(byEnvironmentEntry(entry));

async function waitFor(condition: () => boolean, limitMs = 5000): Promise<void> {
  const end = Date.now() + limitMs;
  while (!condition() && Date.now() < end) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
}

afterEach(async () => {
  for (const entry of markers.splice(0)) await reapProcesses(byEnvironmentEntry(entry), 2000);
});

/** A tree: the direct child (sh), a background sleep in its group, and a sleep that leaves the group with setsid. */
const tree = 'sleep 300 & setsid sleep 301 & sleep 302';

describe.runIf(linux)('process tree (Linux)', () => {
  it('shows the risk: SIGKILL of the direct child leaves its descendants alive', async () => {
    const entry = marker();
    const child = spawn('sh', ['-c', tree], { env: markedEnv(entry), stdio: 'ignore' });
    await waitFor(() => alive(entry).length >= 3);
    child.kill('SIGKILL');
    await new Promise((resolvePromise) => child.on('close', resolvePromise));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(alive(entry).length).toBeGreaterThanOrEqual(2);
    const reaped = await reapProcesses(byEnvironmentEntry(entry));
    expect(reaped.survivors).toEqual([]);
    expect(alive(entry)).toEqual([]);
  });

  it('kills the whole tree on timeout, also a descendant that left the process group, and reports it', async () => {
    const entry = marker();
    const logPath = join(temporaryDirectory('tree'), 'log.txt');
    const started = Date.now();
    const result = await spawnProcess('sh', ['-c', tree], { cwd: '/', env: markedEnv(entry), timeoutSeconds: 1, logPath, reap: byEnvironmentEntry(entry) });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(result.leftovers?.survivors).toEqual([]);
    expect(result.leftovers?.killed).toBeGreaterThanOrEqual(1);
    expect(alive(entry)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(13_000);
    expect(processProblems(result, 'test').join()).toContain('E_ORPHAN_PROCESSES');
  });

  it('kills a descendant that is still alive after a normal end and reports it', async () => {
    const entry = marker();
    const logPath = join(temporaryDirectory('tree'), 'log.txt');
    const result = await spawnProcess('sh', ['-c', 'setsid sleep 303 & exit 0'], { cwd: '/', env: markedEnv(entry), timeoutSeconds: 30, logPath, reap: byEnvironmentEntry(entry) });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.leftovers?.killed).toBeGreaterThanOrEqual(1);
    expect(alive(entry)).toEqual([]);
    expect(processProblems(result, 'test').join()).toContain('E_ORPHAN_PROCESSES');
  });

  it('stops the tree when the runner gets SIGTERM and marks the result as cancelled', async () => {
    const entry = marker();
    const logPath = join(temporaryDirectory('tree'), 'log.txt');
    const pending = spawnProcess('sh', ['-c', tree], { cwd: '/', env: markedEnv(entry), timeoutSeconds: 60, logPath, reap: byEnvironmentEntry(entry) });
    await waitFor(() => alive(entry).length >= 3);
    process.emit('SIGTERM');
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(alive(entry)).toEqual([]);
    expect(processProblems(result, 'test').join()).toContain('E_CANCELLED');
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('refuses to start while selected processes are already alive', async () => {
    const entry = marker();
    const sleeper = spawn('sleep', ['304'], { env: markedEnv(entry), stdio: 'ignore' });
    await waitFor(() => alive(entry).length >= 1);
    let code = 'NO_ERROR';
    try {
      await spawnProcess('true', [], { cwd: '/', env: markedEnv(entry), timeoutSeconds: 5, logPath: join(temporaryDirectory('tree'), 'log.txt'), reap: byEnvironmentEntry(entry) });
    } catch (error) {
      if (error instanceof RunnerError) code = error.code;
    }
    expect(code).toBe('E_RUN_USER_BUSY');
    sleeper.kill('SIGKILL');
  });
});

const python = ['/usr/bin/python3.12', '/usr/local/bin/python3.12'].find((path) => existsSync(path));
const nobodyFree = linux && process.getuid?.() === 0 && liveProcesses().filter(byUid(65534)).length === 0;

describe.runIf(nobodyFree && python !== undefined && existsSync('/usr/bin/unshare'))('the real combination: unshare, Python, and the run user (Linux, root only)', () => {
  it('leaves no process of the run user after a timeout, also when Python started descendants and one left the session', async () => {
    const script = 'import os, subprocess, time\nsubprocess.Popen(["sleep", "305"])\nos.system("setsid sleep 306 &")\ntime.sleep(300)\n';
    const logPath = join(temporaryDirectory('combination'), 'log.txt');
    const result = await spawnProcess(isolationPrefix[0], [...isolationPrefix.slice(1), python ?? '', '-c', script], {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      timeoutSeconds: 3,
      logPath,
      user: { name: 'nobody', uid: 65534, gid: 65534 }
    });
    expect(result.timedOut).toBe(true);
    expect(result.leftovers?.survivors).toEqual([]);
    expect(result.leftovers?.killed).toBeGreaterThanOrEqual(1);
    expect(liveProcesses().filter(byUid(65534))).toEqual([]);
    expect(readFileSync(logPath, 'utf8')).not.toContain('Traceback');
  });
});

describe('run result after a stop', () => {
  const gpuWith =
    (computePids: string): Capture =>
    (command, args) =>
      Promise.resolve(
        command === 'unshare'
          ? { code: 0, stdout: loopbackOnly }
          : args.includes('--query-compute-apps=pid')
            ? { code: 0, stdout: computePids }
            : { code: 0, stdout: 'NVIDIA RTX A5000, 24564, 575.57.08\n' }
      );
  const stopped =
    (result: Awaited<ReturnType<Spawner>>): Spawner =>
    () =>
      Promise.resolve(result);

  it('gives FAIL on timeout, on cancel, and when processes survived, and records that the GPU is free', async () => {
    const cases = [
      { result: { code: null, signal: 'SIGKILL', timedOut: true, leftovers: { killed: 2, survivors: [] } }, codes: ['E_TIMEOUT', 'E_ORPHAN_PROCESSES'] },
      { result: { code: null, signal: 'SIGKILL', timedOut: false, cancelled: true, leftovers: { killed: 0, survivors: [] } }, codes: ['E_CANCELLED'] },
      { result: { code: null, signal: 'SIGKILL', timedOut: true, leftovers: { killed: 3, survivors: [4242] } }, codes: ['E_TIMEOUT', 'E_PROCESS_SURVIVED'] }
    ];
    for (const item of cases) {
      const { bundle, lay, inputPath } = readyWork();
      writeQualified(lay, bundle);
      const result = await runOnce(bundle, lay, inputPath, quietLog, {
        spawner: stopped(item.result),
        capture: gpuWith(''),
        env: {},
        expectedInputSha256: sha256(syntheticImage),
        host: testHost(),
        gpuReleaseMs: 0
      });
      expect(result.status).toBe('FAIL');
      for (const code of item.codes) expect(String(result.problems)).toContain(code);
      expect(result.gpuAfter).toEqual([]);
      expect(result.gpuRelease).toBe('FREE');
    }
  });

  it('gives FAIL when nvidia-smi still shows a compute process after the stop', async () => {
    const { bundle, lay, inputPath } = readyWork();
    writeQualified(lay, bundle);
    const result = await runOnce(bundle, lay, inputPath, quietLog, {
      spawner: stopped({ code: null, signal: 'SIGKILL', timedOut: true, leftovers: { killed: 1, survivors: [] } }),
      capture: gpuWith('31337\n'),
      env: {},
      expectedInputSha256: sha256(syntheticImage),
      host: testHost(),
      gpuReleaseMs: 0
    });
    expect(result.status).toBe('FAIL');
    expect(String(result.problems)).toContain('E_GPU_PROCESS_REMAINS');
    expect(result.gpuRelease).toBe('BUSY');
  });
});

describe('collect after a lost runner', () => {
  it('kills the remaining processes of the run user and records the number, and stops when one survives', async () => {
    const { lay } = readyWork();
    const uids: number[] = [];
    const host = { ...testHost(), reapUser: (uid: number) => (uids.push(uid), Promise.resolve({ killed: 2, survivors: [] })) };
    const summary = await collect(lay, host);
    expect(uids).toEqual([1500]);
    expect(summary.runUserProcessesKilled).toBe(2);
    const stuck = { ...testHost(), reapUser: () => Promise.resolve({ killed: 1, survivors: [77] }) };
    await expect(collect(lay, stuck)).rejects.toMatchObject({ code: 'E_PROCESS_SURVIVED' });
  });
});

describe('GPU release state', () => {
  it('records UNKNOWN, not FREE, when nvidia-smi gives no list', () => {
    expect(gpuReleaseState(null)).toBe('UNKNOWN');
    expect(gpuReleaseState([])).toBe('FREE');
    expect(gpuReleaseState(['31337'])).toBe('BUSY');
  });
});
