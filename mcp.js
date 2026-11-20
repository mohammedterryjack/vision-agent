#!/usr/bin/env node
'use strict';
// Vision tools as an MCP server over stdio (newline-delimited JSON-RPC 2.0). Stateless: every call is forwarded to the
// vision-agent service over its owner-only unix socket, which talks to the Dell.
const fs = require('fs'),
  net = require('net'),
  os = require('os'),
  path = require('path');
const { TOOLS } = require('./tools.js');
const SOCK = process.env.VISION_SOCK || path.join(os.homedir(), '.hermes', 'vision-agent', 'worker.sock');
const CALL_TIMEOUT_MS = +(process.env.VISION_CALL_TIMEOUT_MS || 40 * 60 * 1000);

function ask(req) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(SOCK);
    let buf = '';
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error('the vision service did not answer in time'));
    }, CALL_TIMEOUT_MS);
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.on('data', d => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(timer);
        c.end();
        const r = JSON.parse(buf.slice(0, i));
        r.ok ? resolve(r.result) : reject(new Error(r.error));
      }
    });
    c.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`vision service not reachable at ${SOCK}: ${e.message}`));
    });
  });
}

const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
async function onMessage(m) {
  if (m.method === 'initialize')
    return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'vision', version: '1.0.0' } } });
  if (m.method === 'ping') return out({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params || {};
    try {
      const r = await ask({ op: 'tool', name, args: args || {} });
      if (r.error) return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.error }], isError: true } });
      const content = [{ type: 'text', text: r.text }];
      if (r.image) content.push({ type: 'image', data: fs.readFileSync(r.image).toString('base64'), mimeType: 'image/jpeg' });
      return out({ jsonrpc: '2.0', id: m.id, result: { content } });
    } catch (e) {
      return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true } });
    }
  }
  if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found: ' + m.method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch (e) {
      out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    onMessage(m).catch(e => m.id !== undefined && out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }));
  }
});
process.stdin.on('end', () => process.exit(0));
