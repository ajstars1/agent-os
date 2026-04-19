import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ENV_PATH = join(homedir(), '.agent-os', '.env');

const KNOWN_KEYS: Array<{
  key: string;
  label: string;
  secret: boolean;
  description: string;
}> = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', secret: true, description: 'Required for Claude models' },
  { key: 'GOOGLE_API_KEY', label: 'Google API Key', secret: true, description: 'Required for Gemini models + HAM compression' },
  { key: 'DEFAULT_MODEL', label: 'Default Model', secret: false, description: 'auto | claude | gemini' },
  { key: 'DB_PATH', label: 'Database Path', secret: false, description: 'Path to SQLite memory database' },
  { key: 'SKILLS_DIR', label: 'Skills Directory', secret: false, description: 'Directory containing skill .md files' },
  { key: 'CLAUDE_MD_PATH', label: 'CLAUDE.md Path', secret: false, description: 'Path to system instructions file' },
  { key: 'AGENTS_DIR', label: 'Agents Directory', secret: false, description: 'Directory containing agent .json profiles' },
  { key: 'NEURAL_ENGINE_URL', label: 'Neural Engine URL', secret: false, description: 'URL of PyTorch sleep-cycle backend' },
  { key: 'WEB_PORT', label: 'Web Port', secret: false, description: 'Port for the web API server' },
  { key: 'WEB_CORS_ORIGIN', label: 'CORS Origin', secret: false, description: 'Allowed CORS origin for web API' },
  { key: 'ALLOWED_DIRS', label: 'Allowed Directories', secret: false, description: 'Colon-separated dirs for file tools (empty = cwd only)' },
  { key: 'LOG_LEVEL', label: 'Log Level', secret: false, description: 'debug | info | warn | error' },
  { key: 'DISCORD_TOKEN', label: 'Discord Token', secret: true, description: 'Discord bot token' },
  { key: 'DISCORD_CLIENT_ID', label: 'Discord Client ID', secret: false, description: 'Discord app client ID' },
  { key: 'DISCORD_GUILD_ID', label: 'Discord Guild ID', secret: false, description: 'Discord server ID for slash commands' },
];

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return result;
}

function writeEnv(updates: Record<string, string>): void {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
  for (const [key, value] of Object.entries(updates)) {
    if (value === '') {
      // Remove line
      content = content.replace(new RegExp(`^${key}=.*\n?`, 'm'), '');
    } else {
      const pattern = new RegExp(`^${key}=.*`, 'm');
      if (pattern.test(content)) {
        content = content.replace(pattern, `${key}=${value}`);
      } else {
        content = content.trimEnd() + `\n${key}=${value}\n`;
      }
    }
    // Hot-reload into current process
    if (value) process.env[key] = value;
  }
  writeFileSync(ENV_PATH, content, 'utf-8');
}

function parseBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body) as Record<string, string>);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const SSE_CLIENTS = new Set<ServerResponse>();

function broadcastConfig(): void {
  const env = readEnv();
  const payload = JSON.stringify({ type: 'config', data: env });
  for (const res of SSE_CLIENTS) {
    res.write(`data: ${payload}\n\n`);
  }
}

function buildHtml(env: Record<string, string>): string {
  const rows = KNOWN_KEYS.map(({ key, label, secret, description }) => {
    const val = env[key] ?? '';
    const inputType = secret ? 'password' : 'text';
    const placeholder = secret
      ? (val ? '(currently set — enter new value to change)' : '(not set)')
      : '(not set)';
    const badge = secret
      ? `<span id="badge-${key}" class="key-badge ${val ? 'set' : 'unset'}">${val ? 'set' : 'not set'}</span>`
      : '';
    return `
    <tr>
      <td class="key">
        <label for="field-${key}">${label}</label>
        <div class="desc">${description}</div>
        ${badge}
      </td>
      <td class="val">
        <input id="field-${key}" name="${key}" type="${inputType}"
          value="${secret ? '' : val}" placeholder="${placeholder}"
          data-placeholder="${placeholder}"
          autocomplete="off" spellcheck="false" />
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentOS Config</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: #0d1117;
    color: #c9d1d9;
    min-height: 100vh;
    padding: 2rem;
  }
  h1 {
    font-size: 1.4rem;
    color: #58a6ff;
    margin-bottom: 0.5rem;
    letter-spacing: 0.05em;
  }
  .subtitle {
    color: #8b949e;
    font-size: 0.85rem;
    margin-bottom: 2rem;
  }
  .status-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 0.6rem 1rem;
    margin-bottom: 1.5rem;
    font-size: 0.8rem;
  }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #3fb950;
    flex-shrink: 0;
  }
  .status-dot.disconnected { background: #f85149; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    overflow: hidden;
  }
  tr {
    border-bottom: 1px solid #21262d;
  }
  tr:last-child { border-bottom: none; }
  tr:hover { background: #1c2128; }
  td {
    padding: 0.8rem 1rem;
    vertical-align: middle;
  }
  td.key { width: 42%; }
  label {
    font-weight: 600;
    color: #e6edf3;
    font-size: 0.85rem;
    display: block;
  }
  .desc {
    color: #8b949e;
    font-size: 0.75rem;
    margin-top: 0.25rem;
  }
  input {
    width: 100%;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.5rem 0.75rem;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: #58a6ff; }
  input::placeholder { color: #484f58; }
  .key-badge {
    display: inline-block;
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    margin-top: 0.3rem;
    font-weight: 600;
    letter-spacing: 0.03em;
  }
  .key-badge.set { background: #0d4c1f; color: #3fb950; border: 1px solid #1f6b2e; }
  .key-badge.unset { background: #3d1a1a; color: #f85149; border: 1px solid #6b1f1f; }
  .restart-notice {
    display: none;
    background: #2d2200;
    border: 1px solid #6b4f00;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    color: #e3a400;
    font-size: 0.8rem;
    margin-top: 1rem;
  }
  .restart-notice.visible { display: block; }
  .actions {
    margin-top: 1.5rem;
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  button {
    background: #238636;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 0.55rem 1.2rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    font-weight: 600;
    transition: background 0.15s;
  }
  button:hover { background: #2ea043; }
  button.secondary {
    background: #21262d;
    border: 1px solid #30363d;
    color: #c9d1d9;
  }
  button.secondary:hover { background: #30363d; }
  #toast {
    display: none;
    align-items: center;
    gap: 0.5rem;
    color: #3fb950;
    font-size: 0.82rem;
  }
  #toast.error { color: #f85149; }
  #toast.visible { display: flex; }
</style>
</head>
<body>
<h1>▗▄▖ AgentOS Config</h1>
<p class="subtitle">Changes sync to terminal immediately via hot-reload.</p>

<div class="status-bar">
  <div class="status-dot" id="status-dot"></div>
  <span id="status-text">Connecting to agent…</span>
</div>

<form id="config-form">
  <table>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <div class="actions">
    <button type="submit">Save Changes</button>
    <button type="button" class="secondary" onclick="reloadFromServer()">Reload from Disk</button>
    <span id="toast"></span>
  </div>
  <div class="restart-notice" id="restart-notice">
    ⚠ API key changed — restart <code>aos</code> for it to take effect.
  </div>
</form>

<script>
(function() {
  // SSE live sync
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  let sse;

  function connect() {
    sse = new EventSource('/events');
    sse.onopen = () => {
      dot.classList.remove('disconnected');
      statusText.textContent = 'Connected — changes apply in real-time';
    };
    sse.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'config') {
        applyConfig(msg.data);
      }
    };
    sse.onerror = () => {
      dot.classList.add('disconnected');
      statusText.textContent = 'Disconnected — retrying…';
      sse.close();
      setTimeout(connect, 3000);
    };
  }
  connect();

  const SECRET_KEYS = new Set(['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'DISCORD_TOKEN']);

  function applyConfig(data) {
    for (const [key, val] of Object.entries(data)) {
      const el = document.getElementById('field-' + key);
      if (!el) continue;
      if (el.type === 'password') {
        // Never show the value; update placeholder to reflect set/not-set state
        const badge = document.getElementById('badge-' + key);
        if (badge) {
          badge.textContent = val ? 'set' : 'not set';
          badge.className = 'key-badge ' + (val ? 'set' : 'unset');
        }
        if (!el.value || el.value === el.dataset.placeholder) {
          el.placeholder = val ? '(currently set — enter new value to change)' : '(not set)';
          el.dataset.placeholder = el.placeholder;
        }
      } else {
        el.value = val;
      }
    }
  }

  function showToast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = isError ? '✗ ' + msg : '✓ ' + msg;
    t.className = isError ? 'error visible' : 'visible';
    setTimeout(() => { t.className = ''; }, 3000);
  }

  const SECRET_FIELDS = new Set(['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'DISCORD_TOKEN']);

  document.getElementById('config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const updates = {};
    let changedSecret = false;
    for (const el of form.querySelectorAll('input[name]')) {
      if (el.type === 'password') {
        // Only include if user actually typed a new value (not empty)
        if (el.value && el.value.trim()) {
          updates[el.name] = el.value;
          if (SECRET_FIELDS.has(el.name)) changedSecret = true;
        }
      } else {
        updates[el.name] = el.value;
      }
    }
    try {
      const res = await fetch('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const json = await res.json();
      if (json.ok) {
        showToast('Saved successfully', false);
        if (changedSecret) {
          document.getElementById('restart-notice').classList.add('visible');
        }
        // Clear password fields after save
        for (const el of form.querySelectorAll('input[type="password"]')) {
          el.value = '';
        }
      } else { showToast(json.error || 'Save failed', true); }
    } catch(err) {
      showToast('Network error', true);
    }
  });

  window.reloadFromServer = async function() {
    const res = await fetch('/config');
    const data = await res.json();
    applyConfig(data);
    showToast('Reloaded from disk', false);
  };
})();
</script>
</body>
</html>`;
}

export interface ConfigServer {
  port: number;
  url: string;
  close: () => void;
}

export function startConfigServer(port = 7877): Promise<ConfigServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (url === '/' && req.method === 'GET') {
        const env = readEnv();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(buildHtml(env));
        return;
      }

      if (url === '/config' && req.method === 'GET') {
        const env = readEnv();
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify(env));
        return;
      }

      if (url === '/save' && req.method === 'POST') {
        try {
          const body = await parseBody(req);
          writeEnv(body);
          broadcastConfig();
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err: unknown) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }

      if (url === '/events' && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.writeHead(200);

        // Send current config immediately
        const env = readEnv();
        res.write(`data: ${JSON.stringify({ type: 'config', data: env })}\n\n`);

        SSE_CLIENTS.add(res);

        // Watch .env file for external changes (e.g. /config set from terminal)
        const onFileChange = (): void => { broadcastConfig(); };
        watchFile(ENV_PATH, { interval: 500 }, onFileChange);

        req.on('close', () => {
          SSE_CLIENTS.delete(res);
          unwatchFile(ENV_PATH, onFileChange);
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', reject);

    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${port}`;
      resolve({
        port,
        url,
        close: () => {
          server.close();
          SSE_CLIENTS.clear();
        },
      });
    });
  });
}
