// Fake llama-server used by serverEngine.test.ts. Speaks just enough of the real server's HTTP API:
//   GET /health, GET /props, POST /v1/chat/completions (SSE) with Bearer auth.
// Behaviour is steered by FAKE_* environment variables set by the test.
const http = require('node:http');
const fs = require('node:fs');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(arg('--port'));
const hasMmproj = args.includes('--mmproj');
const key = process.env.LLAMA_API_KEY;
const mode = process.env.FAKE_MODE || 'ok';

if (process.env.FAKE_ARGS_FILE) {
  fs.appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, hasKey: !!key }) + '\n');
}

if (mode === 'oom') {
  console.error('ggml_vulkan: Device memory allocation failed: ErrorOutOfDeviceMemory');
  process.exit(1);
}
if (mode === 'bad-file') {
  console.error('error loading model: invalid magic characters');
  process.exit(1);
}
if (mode === 'blocked') {
  console.error('An Application Control policy has blocked this file.');
  process.exit(1);
}

const startedAt = Date.now();
let requests = 0;

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization;
  if (req.url === '/health') {
    const ready = Date.now() - startedAt > 150;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ready ? { status: 'ok' } : { error: { message: 'Loading model' } }));
    return;
  }
  if (auth !== `Bearer ${key}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API Key', type: 'authentication_error' } }));
    return;
  }
  if (req.url === '/props') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: Number(arg('-c')) || 4096 }, modalities: { vision: hasMmproj } }));
    return;
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      requests++;
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (process.env.FAKE_RECORD_FILE) fs.appendFileSync(process.env.FAKE_RECORD_FILE, JSON.stringify(body) + '\n');
      if (mode === 'overflow-once' && requests === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 400, message: 'the request exceeds the available context size', type: 'exceed_context_size_error' } }));
        return;
      }
      if (mode === 'http-error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'boom' } }));
        return;
      }
      const msgs = body.messages;
      const last = msgs[msgs.length - 1];
      const imageCount = Array.isArray(last.content) ? last.content.filter((p) => p.type === 'image_url').length : 0;
      const text = Array.isArray(last.content) ? last.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : last.content;
      const words = mode === 'think'
        ? ['<th', 'ink>secret plan</thi', 'nk>\n\n', 'Hello ', 'world']
        : ['  ', `msgs=${msgs.length} `, `images=${imageCount} `, `echo=${text} `, 'done'];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let i = 0;
      const delay = mode === 'slow' ? 120 : 5;
      const timer = setInterval(() => {
        if (mode === 'die-mid-stream' && i === 2) {
          process.exit(7);
        }
        if (i < words.length) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: words[i] }, finish_reason: null }] }) + '\n\n');
          i++;
          return;
        }
        if (mode === 'slow') {
          // keep going so the test can abort
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'more ' }, finish_reason: null }] }) + '\n\n');
          return;
        }
        clearInterval(timer);
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_per_second: 42.42 }, usage: { completion_tokens: words.length } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, delay);
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
