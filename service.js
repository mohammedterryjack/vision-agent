'use strict';
// vision-agent: the Vision bot's bridge to the Dell's dell-annotate service (DELL_ANNOTATE, which only
// accepts this machine). The Vision bot (Hermes profile "vision") drives it through mcp.js.
//   * unix socket (owner-only) for mcp.js: newline-delimited JSON {op: "tool", name, args} -> {ok, result: {text, image?}}
//   * HTTP on the LAN address only: a keyless read-only viewer per job at /v/<token>/ (unguessable token per job)
// Outputs are copied to ~/vision/<job_id>/. The Dell key is DELL_LLM_API_KEY in the vision profile's .env, read per
// request. One clear path, errors are returned as they are.
// 20 Nov 2026 (Mo 18:25): reconstruct_3d = the Dell's "geometry" stage (VGGT-Omega on every frame, split into scenes);
// Depth Anything / the depth tool are removed; render makes scene_NN.mp4 + scene_NN_sbs.mp4 per scene. Argument errors
// are Ink style ("error <tool>.<arg>: ...; for example ...") and returned verbatim; results start with the job id.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http'), crypto = require('crypto');

const need = k => { const v = process.env[k]; if (!v) throw new Error(k + ' is not set (see .env.example)'); return v; };
const HOME = os.homedir();
const CFG = {
  dir: process.env.VISION_DIR || path.join(HOME, 'vision'),
  sock: process.env.VISION_SOCK || path.join(HOME, '.hermes', 'vision-agent', 'worker.sock'),
  bind: need('VISION_BIND'),
  port: +(process.env.VISION_PORT || 8647),
  env: process.env.VISION_ENV_FILE || path.join(HOME, '.hermes', 'profiles', 'vision', '.env'),
  dell: need('DELL_ANNOTATE'),
  llm: need('DELL_LLM'),
  llmModel: process.env.DELL_LLM_MODEL || 'Qwen3.8-Flash-Next-UD-IQ4_XS'
};
const JOB_RE = /^[0-9a-f]{16}$/;
const PULL_SKIP = new Set(['source.mp4', 'source.bin', 'job.json']);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// dell-annotate client shared with splat-agent (queue/wait/pull rules live there)
const DA = require(path.join(HOME, 'Code', 'dell-annotate-client'))({ base: CFG.dell, envFile: CFG.env });
const { key, dell, runStage, Pending, short } = DA;
const jobDir = id => { if (!JOB_RE.test(id || '')) throw new Error('job_id must be the 16-hex id from start_job'); return path.join(CFG.dir, id); };

function token(id) {
  const f = path.join(jobDir(id), 'view.token');
  if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, crypto.randomBytes(18).toString('hex'), { mode: 0o600 }); }
  return fs.readFileSync(f, 'utf8').trim();
}
const viewerUrl = id => `http://${CFG.bind}:${CFG.port}/v/${token(id)}/`;

const pull = (id, names, stage) => DA.pull(id, names, jobDir(id), stage);   // resumable: see dell-annotate-client

class UErr extends Error {}   // argument errors: returned verbatim (Ink style), not as "<tool> failed: ..."
const ARGS = { reconstruct_3d: ['job_id', 'conf_percentile'], render: ['job_id', 'base', 'layers'] };
const EXAMPLE = { reconstruct_3d: '{"job_id": "<job_id>", "conf_percentile": 20}', render: '{"job_id": "<job_id>", "base": "depth"}' };
function checkArgs(tool, a) {
  const ex = `; for example ${EXAMPLE[tool]}`;
  if (!JOB_RE.test(a.job_id || '')) throw new UErr(`error ${tool}.job_id: "${a.job_id || ''}" is not a job id; give the 16-hex id from start_job${ex}`);
  for (const k of Object.keys(a)) if (!ARGS[tool].includes(k)) throw new UErr(`error ${tool}.${k}: unknown argument; ${tool} takes ${ARGS[tool].join(', ')}${ex}`);
  if (tool === 'reconstruct_3d' && a.conf_percentile != null && !(typeof a.conf_percentile === 'number' && a.conf_percentile >= 0 && a.conf_percentile <= 99))
    throw new UErr(`error reconstruct_3d.conf_percentile: ${JSON.stringify(a.conf_percentile)} is not a number from 0 to 99${ex}`);
  if (tool === 'render' && a.base != null && !['depth', 'rgb'].includes(a.base))
    throw new UErr(`error render.base: ${JSON.stringify(a.base)} is not depth or rgb${ex}`);
  if (tool === 'render' && a.layers != null && !(Array.isArray(a.layers) && a.layers.every(l => ['tracks', 'pose', 'relations'].includes(l))))
    throw new UErr(`error render.layers: ${JSON.stringify(a.layers)} must be a list of tracks, pose, relations${ex}`);
}
const sceneLine = s => `scene ${s.scene} f${s.frames[0]}-${s.frames[1]} (${s.start_s}-${s.end_s} s)`;
const sceneFiles = d => fs.readdirSync(d).filter(n => /^scene_\d{2}(_sbs)?\.mp4$/.test(n)).sort();

const tools = {
  async start_job(a) {
    const j = await DA.startJob(a);
    fs.mkdirSync(jobDir(j.job), { recursive: true }); token(j.job);
    return { text: `job_id ${j.job}: ${short(j.clip)}` };
  },
  async segment(a) {
    // EntitySAM (prompt-free) then the VLM naming stage; both run on the Dell, queued FIFO. Labels are what pose/relations use.
    // A repeated call after "still running" resumes waiting: segment is not re-run while its label stage is queued/running.
    const st = (await dell('GET', `/v1/jobs/${a.job_id}`)).stages || {};
    const resume = st.segment && st.segment.state === 'done' && st.label && ['queued', 'running'].includes(st.label.state);
    const s = resume ? st.segment : await runStage(a.job_id, 'segment', {});
    const l = await runStage(a.job_id, 'label', {});
    const note = a.prompts ? ' (prompts are not used: EntitySAM finds every entity by itself)' : '';
    return { text: `segment (${s.secs}s, ${s.result.objects} entities) + label (${l.secs}s)${note}: ${short(l.result.labels.map(o => `${o.id} ${o.label} f${o.first_frame}-${o.last_frame}`))}` };
  },
  async pose(a) { const s = await runStage(a.job_id, 'pose', { ids: a.ids }); return { text: `pose (${s.secs}s): ${short(s.result)}` }; },
  async relations(a) { const s = await runStage(a.job_id, 'relations', { predicates: a.predicates }); return { text: `relations (${s.secs}s): ${short(s.result)}` }; },
  async reconstruct_3d(a) {
    // the Dell's queued "geometry" stage: VGGT-Omega on every frame, one pass per scene (scenes = shot cuts)
    checkArgs('reconstruct_3d', a);
    const s = await runStage(a.job_id, 'geometry', { conf_percentile: a.conf_percentile });
    await pull(a.job_id, ['geometry.json', 'geometry_preview.jpg'], 'geometry');   // npz + ply files come with finish
    const r = s.result;
    return { text: `${a.job_id} reconstruct_3d done in ${s.secs}s (peak GPU ${s.peak_gpu_mb} MB): ${r.scenes.length} scene${r.scenes.length === 1 ? '' : 's'}, every frame (${r.frames}) has depth and a camera: ` +
      r.scenes.map(x => `${sceneLine(x)} ${(x.points / 1e6).toFixed(2)}M points`).join('; ') + '. Next: render.', image: path.join(jobDir(a.job_id), 'geometry_preview.jpg') };
  },
  async render(a) {
    checkArgs('render', a);
    const s = await runStage(a.job_id, 'render', { base: a.base, layers: a.layers });
    const r = s.result, mid = String(r.keyframes[Math.floor(r.keyframes.length / 2)]).padStart(6, '0');
    const kf = [`keyframes/overlay_${mid}.jpg`, `keyframes/sbs_${mid}.jpg`];
    await pull(a.job_id, [...r.files, ...kf], 'render');
    return { text: `${a.job_id} render done in ${s.secs}s: ${r.scenes.length} scene${r.scenes.length === 1 ? '' : 's'} (${r.base} background, layers ${r.layers.join(', ') || 'none'}), ` +
      `each an annotated video and a side-by-side with the 3D point of view: ${r.scenes.map(sceneLine).join('; ')}. Viewer: ${viewerUrl(a.job_id)}`, image: path.join(jobDir(a.job_id), kf[1]) };
  },
  async describe(a) {
    const files = (await dell('GET', `/v1/jobs/${a.job_id}/files`)).files.map(f => f.name);
    const pick = files.filter(n => n.startsWith(a.overlay ? 'keyframes/overlay_' : 'keyframes/frame_')).sort();
    if (!pick.length) throw new Error('no keyframes yet: run render first');
    await pull(a.job_id, pick, 'describe');
    const content = [{ type: 'text', text: (a.question || 'Describe what happens in this video clip, in order, with the people and objects involved and how they interact.') + `\n(${pick.length} keyframes in time order${a.overlay ? ', drawn with annotation overlays' : ''}.)` }];
    for (const n of pick) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(jobDir(a.job_id), n)).toString('base64') } });
    const r = await fetch(CFG.llm + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key(), 'Content-Type': 'application/json', 'X-Client': 'vision-agent' },
      body: JSON.stringify({ model: CFG.llmModel, messages: [{ role: 'user', content }], max_tokens: 1200, chat_template_kwargs: { enable_thinking: false } }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`Dell VLM: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    const text = j.choices[0].message.content.trim();
    fs.writeFileSync(path.join(jobDir(a.job_id), 'description.txt'), text + '\n');
    return { text };
  },
  async finish(a) {
    await runStage(a.job_id, 'export', {});
    const files = (await dell('GET', `/v1/jobs/${a.job_id}/files`)).files.map(f => f.name).filter(n => !PULL_SKIP.has(n));
    await pull(a.job_id, files, 'export');
    const j = await dell('GET', `/v1/jobs/${a.job_id}`);
    fs.writeFileSync(path.join(jobDir(a.job_id), 'job.json'), JSON.stringify(j, null, 1));
    const d = jobDir(a.job_id), has = n => fs.existsSync(path.join(d, n));
    const done = Object.entries(j.stages || {}).filter(([, s]) => s.state === 'done').map(([k]) => k).join(', ');
    return { text: [`Annotated ${j.clip ? `${j.clip.name} (${j.clip.frames} frames)` : a.job_id}: ${done}. Files in ${d}/`, `Viewer: ${viewerUrl(a.job_id)}`,
      ...[...sceneFiles(d), 'annotations.coco.json'].filter(has).map(n => 'MEDIA:' + path.join(d, n))].join('\n') };
  },
  async show_job(a) {
    const j = await dell('GET', `/v1/jobs/${a.job_id}`);
    const st = Object.fromEntries(Object.entries(j.stages || {}).map(([k, s]) => [k, s.state === 'queued' ? { state: 'queued', position: s.position, behind: s.ahead }
      : s.state === 'running' ? { state: 'running', progress: s.progress } : { state: s.state, secs: s.secs, error: s.error, result: s.result }]));
    return { text: short({ job: a.job_id, clip: j.clip, stages: st }) };
  },
  async list_jobs() { return { text: short(await dell('GET', '/v1/jobs')) }; },
  async cancel_job(a) {
    // only Vision's own jobs (a job directory under ~/vision exists only for jobs started here)
    if (!fs.existsSync(jobDir(a.job_id))) throw new Error(`job ${a.job_id} was not started by Vision; refusing to cancel it`);
    return { text: short(await dell('POST', `/v1/cancel?job=${a.job_id}`, '')) };
  }
};

// ---------------------------------------------------------------- socket
fs.mkdirSync(path.dirname(CFG.sock), { recursive: true, mode: 0o700 }); fs.mkdirSync(CFG.dir, { recursive: true, mode: 0o700 });
if (fs.existsSync(CFG.sock)) fs.unlinkSync(CFG.sock);
net.createServer(c => {
  let buf = '';
  c.on('data', async d => {
    buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
    const reply = o => c.end(JSON.stringify(o) + '\n');
    let req; try { req = JSON.parse(buf.slice(0, i)); } catch { return reply({ ok: false, error: 'bad request' }); }
    const f = req.op === 'tool' && Object.prototype.hasOwnProperty.call(tools, req.name) && tools[req.name];
    if (!f) return reply({ ok: false, error: `unknown tool ${req.name}` });
    const t0 = Date.now();
    try { const r = await f(req.args || {}); log('tool', req.name, 'ok', Date.now() - t0, 'ms'); reply({ ok: true, result: r }); }
    catch (e) {
      if (e instanceof Pending) { log('tool', req.name, 'pending'); return reply({ ok: true, result: { text: e.message } }); }
      if (e instanceof UErr) { log('tool', req.name, 'bad args', e.message); return reply({ ok: true, result: { error: e.message } }); }
      log('tool', req.name, 'error', e.message); reply({ ok: true, result: { error: `${req.name} failed: ${e.message}` } });
    }
  });
  c.on('error', () => {});
}).listen(CFG.sock, () => { fs.chmodSync(CFG.sock, 0o600); log('socket', CFG.sock); });

// ---------------------------------------------------------------- viewer
const TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.txt': 'text/plain; charset=utf-8', '.npz': 'application/octet-stream' };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function byToken(t) {
  if (!/^[0-9a-f]{36}$/.test(t)) return null;
  for (const id of fs.readdirSync(CFG.dir)) { const f = path.join(CFG.dir, id, 'view.token'); if (JOB_RE.test(id) && fs.existsSync(f) && crypto.timingSafeEqual(Buffer.from(fs.readFileSync(f, 'utf8').trim()), Buffer.from(t))) return id; }
  return null;
}
function scenesHtml(d) {
  const g = fs.existsSync(path.join(d, 'geometry.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'geometry.json'), 'utf8')) : null;
  const sc = sceneFiles(d).filter(n => !n.endsWith('_sbs.mp4'));
  if (!sc.length) return '<p>No annotated scenes yet.</p>';
  return sc.map(n => {
    const k = +n.slice(6, 8), m = g && g.scenes.find(x => x.scene === k), sbs = n.replace('.mp4', '_sbs.mp4');
    return `<h4>Scene ${k}${m ? ` · frames ${m.frames[0]}-${m.frames[1]} · ${m.start_s}-${m.end_s} s` : ''}</h4><video src="${esc(n)}" controls loop autoplay muted playsinline></video>` +
      (fs.existsSync(path.join(d, sbs)) ? `<p>Side by side: annotated | VGGT-Omega reconstruction from the estimated camera</p><video src="${esc(sbs)}" controls loop autoplay muted playsinline></video>` : '');
  }).join('\n');
}
function page(id) {
  const d = jobDir(id), j = fs.existsSync(path.join(d, 'job.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'job.json'), 'utf8')) : {};
  const kf = fs.existsSync(path.join(d, 'keyframes')) ? fs.readdirSync(path.join(d, 'keyframes')).filter(n => n.startsWith('overlay_')).sort() : [];
  const files = fs.readdirSync(d).filter(n => !['view.token', 'keyframes'].includes(n) && !n.endsWith('.part') && !n.startsWith('.')).sort();
  const desc = fs.existsSync(path.join(d, 'description.txt')) ? fs.readFileSync(path.join(d, 'description.txt'), 'utf8') : '';
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Vision ${esc(id)}</title>
<style>body{background:#000;color:#ddd;font:14px/1.4 system-ui,sans-serif;margin:0;padding:12px}video,img{max-width:100%;border:1px solid #333}a{color:#8cf}.k{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px}pre{white-space:pre-wrap}</style>
<h3>Vision · ${esc(j.clip ? j.clip.name : id)}</h3>${scenesHtml(d)}
${fs.existsSync(path.join(d, 'geometry_preview.jpg')) ? '<h4>3D (VGGT-Omega): point cloud per scene</h4><a href="geometry_preview.jpg"><img src="geometry_preview.jpg"></a>' : ''}${desc ? `<pre>${esc(desc)}</pre>` : ''}<div class=k>${kf.map(n => `<a href="keyframes/${n}"><img src="keyframes/${n}" loading=lazy></a>`).join('')}</div>
<p>${files.map(n => `<a href="${esc(n)}">${esc(n)}</a>`).join(' · ')}</p>`;
}
http.createServer((req, res) => {
  const m = /^\/v\/([0-9a-f]+)\/(.*)$/.exec(decodeURIComponent((req.url || '').split('?')[0]));
  const id = m && byToken(m[1]);
  if (req.method !== 'GET' || !id) { res.writeHead(404); return res.end('not found'); }
  const rel = m[2];
  if (!rel) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page(id)); }
  if (!/^(keyframes\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(rel) || rel === 'view.token') { res.writeHead(404); return res.end('not found'); }
  const f = path.join(jobDir(id), rel);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  const size = fs.statSync(f).size, type = TYPES[path.extname(f)] || 'application/octet-stream', r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) { const s = r[1] ? +r[1] : size - +r[2], e = r[1] && r[2] ? +r[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' }); return fs.createReadStream(f, { start: s, end: e }).pipe(res); }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' }); fs.createReadStream(f).pipe(res);
}).listen(CFG.port, CFG.bind, () => log('http', `${CFG.bind}:${CFG.port}`));

// finish copies a previous run left half done (killed or restarted mid-pull)
DA.resumePulls(CFG.dir, log);
