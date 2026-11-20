'use strict';
// node --test test/vision.test.js   (20 Nov 2026: VGGT geometry in Vision, Depth Anything removed, per-scene render)
// Starts a private copy of service.js on a temp socket/port/dir: only argument checks and the viewer are exercised
// (nothing is sent to the Dell).
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), cp = require('child_process'), http = require('http');
const DIR = path.resolve(__dirname, '..');
const { TOOLS } = require(path.join(DIR, 'tools.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-test-'));
const SOCK = path.join(tmp, 's.sock'), PORT = 18000 + Math.floor(Math.random() * 1000);
const env = { ...process.env, VISION_DIR: path.join(tmp, 'v'), VISION_SOCK: SOCK, VISION_BIND: '127.0.0.1', VISION_PORT: String(PORT), VISION_ENV_FILE: path.join(tmp, 'env'), DELL_ANNOTATE: 'http://127.0.0.1:9', DELL_LLM: 'http://127.0.0.1:9/v1' };
fs.writeFileSync(env.VISION_ENV_FILE, 'DELL_LLM_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx\n');
let svc;
const ask = req => new Promise((res, rej) => { const c = net.createConnection(SOCK); let b = ''; c.on('connect', () => c.write(JSON.stringify(req) + '\n')); c.on('data', d => { b += d; const i = b.indexOf('\n'); if (i >= 0) { c.end(); res(JSON.parse(b.slice(0, i))); } }); c.on('error', rej); });
const get = p => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
test.before(async () => {
  svc = cp.spawn(process.execPath, [path.join(DIR, 'service.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 50 && !fs.existsSync(SOCK); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(SOCK), 'service did not start');
  await new Promise(r => setTimeout(r, 200));
});
test.after(() => { svc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('no depth tool; reconstruct_3d and render are the VGGT path', () => {
  const names = TOOLS.map(t => t.name);
  assert.ok(!names.includes('depth'));
  assert.ok(names.includes('reconstruct_3d') && names.includes('render'));
  const r3 = TOOLS.find(t => t.name === 'reconstruct_3d'), rd = TOOLS.find(t => t.name === 'render');
  assert.match(r3.description, /^Rebuild every frame in 3D with VGGT-Omega/);
  assert.deepStrictEqual(Object.keys(r3.inputSchema.properties).sort(), ['conf_percentile', 'job_id']);
  assert.match(rd.description, /^Draw one annotated video per scene/);
  assert.deepStrictEqual(rd.inputSchema.properties.base.enum, ['depth', 'rgb']);
  for (const t of TOOLS) assert.ok(!/Depth Anything/i.test(t.description), t.name);
});
test('Ink-style argument errors, verbatim, before the Dell is asked', async () => {
  const cases = [
    [{ name: 'reconstruct_3d', args: { job_id: 'nope' } }, /^error reconstruct_3d\.job_id: "nope" is not a job id; .*; for example \{"job_id"/],
    [{ name: 'reconstruct_3d', args: { job_id: '0123456789abcdef', max_frames: 5 } }, /^error reconstruct_3d\.max_frames: unknown argument; .*for example/],
    [{ name: 'reconstruct_3d', args: { job_id: '0123456789abcdef', conf_percentile: 120 } }, /^error reconstruct_3d\.conf_percentile: 120 is not a number from 0 to 99; for example/],
    [{ name: 'render', args: { job_id: '0123456789abcdef', base: 'auto' } }, /^error render\.base: "auto" is not depth or rgb; for example/],
    [{ name: 'render', args: { job_id: '0123456789abcdef', layers: ['depth'] } }, /^error render\.layers: .*for example/]
  ];
  for (const [req, re] of cases) { const r = await ask({ op: 'tool', ...req }); assert.ok(r.ok); assert.match(r.result.error, re); }
  const d = await ask({ op: 'tool', name: 'depth', args: { job_id: '0123456789abcdef' } });
  assert.strictEqual(d.ok, false); assert.match(d.error, /unknown tool depth/);
});
test('viewer shows one annotated video and one side-by-side per scene', async () => {
  const id = 'fedcba9876543210', d = path.join(env.VISION_DIR, id); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'view.token'), 'a'.repeat(36));
  for (const n of ['scene_01.mp4', 'scene_01_sbs.mp4', 'scene_02.mp4', 'scene_02_sbs.mp4']) fs.writeFileSync(path.join(d, n), 'x');
  fs.writeFileSync(path.join(d, 'geometry.json'), JSON.stringify({ scenes: [{ scene: 1, frames: [0, 90], start_s: 0, end_s: 3.033 }, { scene: 2, frames: [91, 159], start_s: 3.033, end_s: 5.333 }] }));
  const r = await get(`/v/${'a'.repeat(36)}/`);
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Scene 1 · frames 0-90/); assert.match(r.body, /Scene 2 · frames 91-159/);
  assert.match(r.body, /src="scene_01_sbs.mp4"/); assert.match(r.body, /src="scene_02.mp4"/);
  assert.ok(!/overlay\.mp4/.test(r.body));
  assert.strictEqual((await get(`/v/${'a'.repeat(36)}/scene_02_sbs.mp4`)).status, 200);
});
