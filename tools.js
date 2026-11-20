'use strict';
// Vision tool definitions (MCP tools/list). Every tool runs on the Dell's dell-annotate service through vision-agent.
// 20 Nov 2026 (Mo 18:25): VGGT-Omega is Vision's 3D/depth stage (reconstruct_3d, every frame, split into scenes); Depth
// Anything and the depth tool are gone; render returns one annotated video per scene plus a side-by-side point-of-view video.
const job = { type: 'string', description: 'job_id from start_job' };
const T = (name, description, properties = {}, required = ['job_id']) => ({ name, description, inputSchema: { type: 'object', properties: { job_id: job, ...properties }, required, additionalProperties: false } });
const TOOLS = [
  { name: 'start_job', description: 'Upload a video clip to the Dell and start an annotation job. Give the clip as a file path on this machine (e.g. an attachment path from the chat) or an http(s) URL. Optionally only part of it: start and duration in seconds. The Dell keeps every frame (long side <= 1280 px, constant fps, at most 300 frames). Returns job_id and clip size/fps/frames.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' }, start: { type: 'number' }, duration: { type: 'number' }, name: { type: 'string', description: 'short label for the job' } }, additionalProperties: false } },
  T('segment', 'EntitySAM ViT-L: finds, segments and tracks every entity in the clip on its own (people, objects and surfaces such as floor or shelves, up to 50; also ones that appear later), one id per entity across all frames, then the Dell VLM names each entity. No prompts. Required before pose and relations. Slow: about 2.5 s per frame plus 1-3 min naming.'),
  T('pose', 'Sapiens2-0.8B: 308 keypoints (body, feet, hands, face) for every tracked entity named person (or the ids given) on every frame. Needs segment.', { ids: { type: 'array', items: { type: 'integer' }, description: 'only these person track ids' } }),
  T('reconstruct_3d', 'Rebuild every frame in 3D with VGGT-Omega, split into natural scenes at the cuts: depth for the annotated video, a camera per frame and a point cloud per scene. Needed before render. Queues on the Dell; returns the job id, the scenes and a point-cloud preview.',
    { conf_percentile: { type: 'number', minimum: 0, maximum: 99, description: 'drop the least confident points, default 20' } }),
  T('relations', 'RelateAnything: subject-predicate-object relations between the named entities on every frame, merged into time spans. Needs segment.', { predicates: { type: 'array', items: { type: 'string' }, description: 'custom predicate vocabulary (optional)' } }),
  T('render', 'Draw one annotated video per scene (VGGT depth background, coloured masks, labels, skeletons, relation lines) and a side-by-side per scene: annotated video left, the scene\'s 3D point cloud seen from the moving camera right. Needs reconstruct_3d. base: depth (default) or rgb. layers: any of tracks, pose, relations (default: all computed).',
    { base: { type: 'string', enum: ['depth', 'rgb'] }, layers: { type: 'array', items: { type: 'string', enum: ['tracks', 'pose', 'relations'] } } }),
  T('describe', 'Ask the Dell VLM (Qwen) about the clip using the rendered keyframes (plain frames, and the overlays if overlay is true). Needs render.', { question: { type: 'string' }, overlay: { type: 'boolean' } }),
  T('finish', 'Export COCO-style annotations, copy every output to ~/vision/<job_id>/ on this machine, and return the lines to reply with: the Viewer link and MEDIA lines (per scene: annotated video, then side-by-side).'),
  T('show_job', 'State and results of every stage of a job, plus one overlay keyframe if rendered.'),
  { name: 'list_jobs', description: 'Recent annotation jobs on the Dell.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  T('cancel_job', 'Stop the running stage and drop the queued stages of one of your own jobs, only when Mo asks to stop. Jobs started elsewhere cannot be cancelled. Never use it to make room: when the Dell is busy, stages queue (FIFO) and the other tools wait their turn by themselves.')
];
module.exports = { TOOLS };
