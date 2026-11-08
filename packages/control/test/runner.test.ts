import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleCommand } from '@control/bundle';
import { writeFiles } from '@control/output';
import { encodePng } from '@control/png';
import { Raster } from '@control/raster';
import { type ApprovedModel, approvedModels, execute, type ExecuteOptions, type FetchFunction, loadBundle, parseBundle, RunnerError, sha256, status } from '@control/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { temporaryDirectory } from './helpers';

const candidateBytes = (): Buffer => readFileSync(fileURLToPath(new URL('fixtures/c05-candidate/rig.contract.json', import.meta.url)));
const distRunner = fileURLToPath(new URL('../dist/src/runner.js', import.meta.url));
const runnerBytes = (): Buffer => readFileSync(distRunner);

// Synthetic model files: small deterministic bytes with the same structure as the approved list. No real weights are used.
const syntheticBytes = (seed: number, length: number): Buffer => Buffer.from(Array.from({ length }, (_, index) => (index * 31 + seed * 7) % 251));
const checkpointBytes = syntheticBytes(1, 4096);
const controlNetBytes = syntheticBytes(2, 2048);
const synthetic: readonly ApprovedModel[] = [
  { ...(approvedModels[0] as ApprovedModel), file: 'synthetic-checkpoint.safetensors', size: checkpointBytes.length, sha256: sha256(checkpointBytes) },
  { ...(approvedModels[1] as ApprovedModel), file: 'synthetic-controlnet.safetensors', size: controlNetBytes.length, sha256: sha256(controlNetBytes) }
];
const bytesFor = (model: ApprovedModel): Buffer => (model.folder === 'checkpoints' ? checkpointBytes : controlNetBytes);

/** A fetch for model downloads: it serves the synthetic bytes and counts the calls. No network access. */
function fakeDownloads(override?: (model: ApprovedModel) => Buffer): { fetchImpl: FetchFunction; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchFunction = async (url, init) => {
    if (url.startsWith('http://127.0.0.1')) return fetch(url, init);
    calls.push(url);
    const model = synthetic.find((item) => url.endsWith(`/${item.file}`));
    if (!model) return new Response('not found', { status: 404 });
    const body = override ? override(model) : bytesFor(model);
    return new Response(new Uint8Array(body), { status: 200 });
  };
  return { fetchImpl, calls };
}

type Fake = {
  server: Server;
  port: number;
  prompts: unknown[];
  history: Map<string, unknown>;
  input: Map<string, Buffer>;
  modelsDir: string;
  mode: { error: boolean; lose: boolean; dropResponse: boolean; missingNode: string | null };
};

const outputImage = encodePng(new Raster(832, 1216, [10, 20, 30, 255]));

/** A minimal fake ComfyUI API on 127.0.0.1 with the endpoints that the runner uses. */
async function fakeComfy(modelsDir: string): Promise<Fake> {
  const fake: Omit<Fake, 'server' | 'port'> = { prompts: [], history: new Map(), input: new Map(), modelsDir, mode: { error: false, lose: false, dropResponse: false, missingNode: null } };
  const send = (response: ServerResponse, code: number, value: unknown): void => {
    response.writeHead(code, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const body = async (request: IncomingMessage): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part as Buffer);
    return Buffer.concat(parts);
  };
  const list = (folder: string): string[] => (existsSync(join(modelsDir, folder)) ? readdirSync(join(modelsDir, folder)) : []);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/system_stats')
        return send(response, 200, { system: { comfyui_version: '0.3.test', python_version: '3.12', pytorch_version: '2.test' }, devices: [{ name: 'Fake GPU', type: 'cuda', vram_total: 1 }] });
      if (url.pathname.startsWith('/object_info/')) {
        const type = decodeURIComponent(url.pathname.slice('/object_info/'.length));
        if (type === fake.mode.missingNode) return send(response, 200, {});
        const required = type === 'CheckpointLoaderSimple' ? { ckpt_name: [list('checkpoints')] } : type === 'ControlNetLoader' ? { control_net_name: [list('controlnet')] } : {};
        return send(response, 200, { [type]: { input: { required } } });
      }
      if (url.pathname === '/upload/image' && request.method === 'POST') {
        const form = await new Request('http://127.0.0.1/upload', {
          method: 'POST',
          headers: { 'content-type': request.headers['content-type'] ?? '' },
          body: new Uint8Array(await body(request))
        }).formData();
        const file = form.get('image') as File;
        fake.input.set(file.name, Buffer.from(await file.arrayBuffer()));
        return send(response, 200, { name: file.name, subfolder: '', type: 'input' });
      }
      if (url.pathname === '/prompt' && request.method === 'POST') {
        const value = JSON.parse((await body(request)).toString('utf8')) as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> };
        fake.prompts.push(value.prompt);
        const id = `prompt-${fake.prompts.length}`;
        if (!fake.mode.lose) {
          const prefix = String(value.prompt['7']?.inputs.filename_prefix);
          fake.history.set(
            id,
            fake.mode.error
              ? { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'KSampler', exception_message: 'out of memory' }]] }, outputs: {} }
              : { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '7': { images: [{ filename: `${prefix}_00001_.png`, subfolder: '', type: 'output' }] } } }
          );
        }
        // The server accepted and queued the prompt, but the connection breaks before the answer.
        if (fake.mode.dropResponse) return request.socket.destroy();
        return send(response, 200, { prompt_id: id, number: fake.prompts.length, node_errors: {} });
      }
      if (url.pathname.startsWith('/history/')) {
        const id = decodeURIComponent(url.pathname.slice('/history/'.length));
        return send(response, 200, fake.history.has(id) ? { [id]: fake.history.get(id) } : {});
      }
      if (url.pathname === '/queue') return send(response, 200, { queue_running: [], queue_pending: [] });
      if (url.pathname === '/view') {
        const bytes = url.searchParams.get('type') === 'input' ? fake.input.get(url.searchParams.get('filename') ?? '') : outputImage;
        if (!bytes) return send(response, 404, {});
        response.writeHead(200, { 'content-type': 'image/png' });
        return response.end(bytes);
      }
      return send(response, 404, { error: 'not found' });
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { ...fake, server, port: (server.address() as AddressInfo).port };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

/** A written bundle for the synthetic models, an empty ComfyUI models folder, and a fake ComfyUI. */
async function setup(): Promise<{ root: string; modelsDir: string; out: string; fake: Fake; base: Omit<ExecuteOptions, 'command'> }> {
  const work = temporaryDirectory();
  const root = join(work, 'bundle');
  writeFiles(root, bundleCommand({ contractBytes: candidateBytes(), runnerBytes: runnerBytes(), approved: synthetic }).files, true);
  const modelsDir = join(work, 'models');
  mkdirSync(join(modelsDir, 'checkpoints'), { recursive: true });
  mkdirSync(join(modelsDir, 'controlnet'), { recursive: true });
  const fake = await fakeComfy(modelsDir);
  servers.push(fake.server);
  const out = join(work, 'results');
  return { root, modelsDir, out, fake, base: { bundleRoot: root, modelsDir, out, port: fake.port, timeoutMs: 5000, pollMs: 5, quiet: true, approved: synthetic } };
}

const errorCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RunnerError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('bundle', () => {
  it('is deterministic and lists every file with its SHA-256', () => {
    const first = bundleCommand({ contractBytes: candidateBytes(), runnerBytes: runnerBytes() });
    const second = bundleCommand({ contractBytes: candidateBytes(), runnerBytes: runnerBytes() });
    expect(first.files.map((file) => file.bytes)).toEqual(second.files.map((file) => file.bytes));
    const names = first.files.map((file) => file.name).sort();
    expect(names).toEqual(['README.md', 'SHA256SUMS', 'bundle.json', 'c0-baseline-1001.api.json', 'c0-pose-1001.api.json', 'openpose-anatomical.png', 'run-plan.json', 'run.sh', 'runner.mjs'].sort());
    const sums = first.files.find((file) => file.name === 'SHA256SUMS')?.bytes.toString('utf8') ?? '';
    for (const file of first.files.filter((item) => item.name !== 'SHA256SUMS')) expect(sums).toContain(`${sha256(file.bytes)}  ${file.name}\n`);
    const manifest = parseBundle(JSON.parse(first.files.find((file) => file.name === 'bundle.json')?.bytes.toString('utf8') ?? '{}'));
    expect(manifest.models).toEqual(approvedModels);
    expect(manifest.runs.map((run) => [run.kind, run.seed])).toEqual([
      ['baseline', 1001],
      ['pose', 1001]
    ]);
  });

  it('refuses a contract that is not the C0.5 candidate', () => {
    const l1 = readFileSync(fileURLToPath(new URL('../../rig-runtime/test/fixtures/l1-owner/rig.contract.json', import.meta.url)));
    expect(() => bundleCommand({ contractBytes: l1, runnerBytes: runnerBytes() })).toThrow(/C0\.5 candidate/);
  });

  it('refuses a changed file and a changed model list', async () => {
    const { root } = await setup();
    expect(() => loadBundle(root, synthetic)).not.toThrow();
    expect(() => loadBundle(root, approvedModels)).toThrow(/approved model files/);
    const path = join(root, 'c0-pose-1001.api.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"seed": 1001', '"seed": 1002'));
    expect(() => loadBundle(root, synthetic)).toThrow(/does not agree with bundle.json/);
    const image = join(root, 'openpose-anatomical.png');
    const copy = join(root, '..', 'copy.png');
    writeFileSync(copy, readFileSync(image));
    rmSync(image);
    symlinkSync(copy, image);
    expect(() => loadBundle(root, synthetic)).toThrow(/cannot be opened|does not agree/);
  });
});

describe('runner with a fake ComfyUI', () => {
  it('downloads the missing models, runs the two workflows once, and saves the results with SHA-256', async () => {
    const { modelsDir, out, fake, base } = await setup();
    const downloads = fakeDownloads();
    const report = await execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl, urlFor: (model) => `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.file}` });
    expect(report.status).toBe('PASS');
    expect(downloads.calls).toHaveLength(2);
    expect(fake.prompts).toHaveLength(2);
    expect(readFileSync(join(modelsDir, 'checkpoints', 'synthetic-checkpoint.safetensors')).equals(checkpointBytes)).toBe(true);
    expect(readdirSync(join(modelsDir, 'checkpoints'))).toEqual(['synthetic-checkpoint.safetensors']);
    const image = sha256(outputImage);
    expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toBe(`${image}  baseline-1001.png\n${image}  pose-1001.png\n`);
    expect(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))).toMatchObject({ status: 'PASS', comfyui: { comfyuiVersion: '0.3.test' } });
    expect(fake.input.get('openpose-anatomical.png')?.equals(readFileSync(join(base.bundleRoot, 'openpose-anatomical.png')))).toBe(true);
    const pose = fake.prompts[1] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(pose['5']?.inputs.seed).toBe(1001);
    expect(existsSync(join(out, '.lock'))).toBe(false);
    expect(readFileSync(join(out, 'run.log'), 'utf8')).not.toMatch(/token|password|authorization/i);
    expect(status(out).status).toBe('PASS');

    const again = await execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl });
    expect(again.status).toBe('PASS');
    expect(again.note).toMatch(/agree with result.json and SHA256SUMS\. Nothing was run again/);
    expect(fake.prompts).toHaveLength(2);
    expect(downloads.calls).toHaveLength(2);
  });

  it('verifies the saved results again after PASS and fails without a new generation when they changed', async () => {
    const { out, fake, base } = await setup();
    const downloads = fakeDownloads();
    expect((await execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl })).status).toBe('PASS');
    const pose = readFileSync(join(out, 'pose-1001.png'));
    const sums = readFileSync(join(out, 'SHA256SUMS'));

    rmSync(join(out, 'pose-1001.png'));
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_RESULT_CHANGED');
    expect(status(out)).toMatchObject({ status: 'FAIL', problems: ['pose-1001.png is missing'] });

    writeFileSync(join(out, 'pose-1001.png'), Buffer.concat([pose, Buffer.from([0])]));
    expect(await errorCode(execute({ ...base, command: 'run' }))).toBe('E_RESULT_CHANGED');
    expect(status(out)).toMatchObject({ status: 'FAIL', problems: ['pose-1001.png has another SHA-256'] });

    writeFileSync(join(out, 'pose-1001.png'), pose);
    writeFileSync(join(out, 'SHA256SUMS'), `${'0'.repeat(64)}  baseline-1001.png\n`);
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_RESULT_CHANGED');
    expect(status(out).status).toBe('FAIL');

    writeFileSync(join(out, 'SHA256SUMS'), sums);
    expect((await execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl })).status).toBe('PASS');
    expect(fake.prompts).toHaveLength(2);
    expect(downloads.calls).toHaveLength(2);
    expect(existsSync(join(out, '.lock'))).toBe(false);
  });

  it('stops with E_SUBMISSION_AMBIGUOUS and never submits again when the answer to POST /prompt is lost', async () => {
    const { out, fake, base } = await setup();
    fake.mode.dropResponse = true;
    const downloads = fakeDownloads();
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_SUBMISSION_AMBIGUOUS');
    expect(fake.prompts).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(out, 'state.json'), 'utf8')) as { runs: Record<string, Record<string, unknown>> };
    expect(typeof state.runs['baseline-1001']?.clientId).toBe('string');
    expect(typeof state.runs['baseline-1001']?.submissionStartedAt).toBe('string');
    expect(state.runs['baseline-1001']?.promptId).toBeUndefined();
    expect(status(out)).toMatchObject({ status: 'INCOMPLETE', runs: [{ id: 'baseline-1001', submissionAmbiguous: true }] });

    fake.mode.dropResponse = false;
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_SUBMISSION_AMBIGUOUS');
    expect(await errorCode(execute({ ...base, command: 'run' }))).toBe('E_SUBMISSION_AMBIGUOUS');
    expect(fake.prompts).toHaveLength(1);
    expect(existsSync(join(out, '.lock'))).toBe(false);
  });

  it('check does not download and reports INCOMPLETE when models are missing', async () => {
    const { out, base } = await setup();
    const downloads = fakeDownloads();
    const report = await execute({ ...base, command: 'check', fetchImpl: downloads.fetchImpl });
    expect(report.status).toBe('INCOMPLETE');
    expect(downloads.calls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });

  it('follows a linked model folder and refuses a linked results directory', async () => {
    const { modelsDir, out, base } = await setup();
    const real = join(modelsDir, '..', 'volume-checkpoints');
    mkdirSync(real);
    rmSync(join(modelsDir, 'checkpoints'), { recursive: true });
    symlinkSync(real, join(modelsDir, 'checkpoints'));
    const downloads = fakeDownloads();
    expect((await execute({ ...base, command: 'models', fetchImpl: downloads.fetchImpl })).status).toBe('PASS');
    expect(readdirSync(real)).toEqual(['synthetic-checkpoint.safetensors']);
    const linked = join(out, '..', 'linked-results');
    symlinkSync(out, linked);
    expect(await errorCode(execute({ ...base, command: 'run', out: linked }))).toBe('E_PATH');
  });

  it('never replaces an existing model file with another SHA-256', async () => {
    const { modelsDir, base } = await setup();
    const path = join(modelsDir, 'checkpoints', 'synthetic-checkpoint.safetensors');
    writeFileSync(path, 'other bytes');
    const downloads = fakeDownloads();
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_MODEL_HASH_MISMATCH');
    expect(readFileSync(path, 'utf8')).toBe('other bytes');
    expect(downloads.calls).toHaveLength(0);
  });

  it('removes a downloaded file with a wrong SHA-256 and does not generate', async () => {
    const { modelsDir, fake, base } = await setup();
    const downloads = fakeDownloads((model) => Buffer.alloc(model.size, 7));
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_MODEL_HASH_MISMATCH');
    expect(readdirSync(join(modelsDir, 'checkpoints'))).toEqual([]);
    expect(fake.prompts).toHaveLength(0);
  });

  it('stops on a ComfyUI error and does not submit the run again', async () => {
    const { fake, base } = await setup();
    fake.mode.error = true;
    const downloads = fakeDownloads();
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_GENERATION_FAILED');
    expect(fake.prompts).toHaveLength(1);
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_GENERATION_FAILED');
    expect(fake.prompts).toHaveLength(1);
  });

  it('stops with E_PROMPT_LOST when ComfyUI forgot a submitted prompt', async () => {
    const { fake, base } = await setup();
    fake.mode.lose = true;
    const downloads = fakeDownloads();
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl, timeoutMs: 50 }))).toBe('E_TIMEOUT');
    expect(await errorCode(execute({ ...base, command: 'all', fetchImpl: downloads.fetchImpl }))).toBe('E_PROMPT_LOST');
    expect(fake.prompts).toHaveLength(1);
  });

  it('stops when ComfyUI has no union ControlNet type node', async () => {
    const { fake, base } = await setup();
    fake.mode.missingNode = 'SetUnionControlNetType';
    expect(await errorCode(execute({ ...base, command: 'check' }))).toBe('E_COMFYUI_NODE');
  });

  it('stops when ComfyUI does not answer', async () => {
    const { base } = await setup();
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((done) => closed.close(done));
    expect(await errorCode(execute({ ...base, command: 'check', port }))).toBe('E_COMFYUI_UNREACHABLE');
  });
});

describe('runner CLI', () => {
  it('gives a JSON usage error and status INCOMPLETE for an empty results directory', () => {
    const usage = spawnSync(process.execPath, [distRunner, '--unknown'], { encoding: 'utf8' });
    expect(usage.status).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({ status: 'ERROR', code: 'E_USAGE' });
    const empty = temporaryDirectory();
    const result = spawnSync(process.execPath, [distRunner, 'status', '--out', empty], { encoding: 'utf8' });
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'INCOMPLETE' });
  });
});
