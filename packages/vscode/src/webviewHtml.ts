/** Returns the full HTML for the AgentOS chat webview panel. */
export function getChatHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentOS Chat</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    #status-bar {
      padding: 4px 10px;
      font-size: 11px;
      background: var(--vscode-statusBar-background, #007acc);
      color: var(--vscode-statusBar-foreground, #fff);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    #status-dot { width: 7px; height: 7px; border-radius: 50%; background: #666; flex-shrink: 0; }
    #status-dot.connected { background: #4caf50; }
    #status-dot.error { background: #f44336; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg { max-width: 100%; word-wrap: break-word; }
    .msg.user {
      align-self: flex-end;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border-radius: 10px 10px 2px 10px;
      padding: 8px 12px;
      max-width: 85%;
      white-space: pre-wrap;
    }
    .msg.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-inactiveSelectionBackground, #3a3d41);
      border-radius: 2px 10px 10px 10px;
      padding: 8px 12px;
      max-width: 92%;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .msg.assistant.streaming::after {
      content: '▋';
      animation: blink 0.7s infinite;
      margin-left: 2px;
    }
    @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
    .msg-meta { font-size: 10px; opacity: 0.5; margin-top: 3px; }
    .tool-status {
      font-size: 11px;
      opacity: 0.6;
      font-style: italic;
      padding: 2px 6px;
      align-self: flex-start;
    }
    #input-area {
      padding: 8px 10px;
      border-top: 1px solid var(--vscode-panel-border, #444);
      display: flex;
      gap: 6px;
      align-items: flex-end;
      flex-shrink: 0;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    #input {
      flex: 1;
      min-height: 36px;
      max-height: 120px;
      padding: 7px 10px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      resize: none;
      font-family: inherit;
      font-size: inherit;
      outline: none;
    }
    #input:focus { border-color: var(--vscode-focusBorder, #0078d4); }
    #send-btn {
      padding: 7px 14px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      height: 36px;
      flex-shrink: 0;
    }
    #send-btn:hover { opacity: 0.85; }
    #send-btn:disabled { opacity: 0.4; cursor: default; }
    #context-pill {
      font-size: 10px;
      padding: 2px 6px;
      background: var(--vscode-badge-background, #0078d4);
      color: var(--vscode-badge-foreground, #fff);
      border-radius: 8px;
      margin-bottom: 4px;
      align-self: flex-start;
      display: none;
    }
    code { background: var(--vscode-textCodeBlock-background, #1e1e1e); padding: 1px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <div id="status-bar">
    <span id="status-dot"></span>
    <span id="status-text">Connecting…</span>
    <span id="model-badge" style="margin-left:auto; font-size:10px; opacity:0.8;"></span>
  </div>

  <div id="messages"></div>

  <div id="input-area">
    <div style="flex:1; display:flex; flex-direction:column;">
      <span id="context-pill"></span>
      <textarea id="input" placeholder="Ask AgentOS… (Shift+Enter for newline)" rows="1"></textarea>
    </div>
    <button id="send-btn">↑</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const modelBadge = document.getElementById('model-badge');
    const contextPill = document.getElementById('context-pill');

    let conversationId = null;
    let currentAssistantMsg = null;
    let connected = false;
    let currentFile = null;

    // ── Connection status ──
    function setStatus(ok, text) {
      connected = ok;
      statusDot.className = ok ? 'connected' : 'error';
      statusText.textContent = text;
      sendBtn.disabled = !ok;
    }
    setStatus(false, 'Connecting…');

    // ── Append a message bubble ──
    function appendMsg(role, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + role;
      el.textContent = text;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return el;
    }

    function appendToolStatus(text) {
      const el = document.createElement('div');
      el.className = 'tool-status';
      el.textContent = '⚙ ' + text;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return el;
    }

    // ── Send message ──
    function send() {
      const text = inputEl.value.trim();
      if (!text || !connected) return;

      appendMsg('user', text);
      inputEl.value = '';
      autoResize();
      sendBtn.disabled = true;

      currentAssistantMsg = appendMsg('assistant', '');
      currentAssistantMsg.classList.add('streaming');

      vscode.postMessage({ type: 'send', message: text, conversationId });
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    function autoResize() {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    }
    inputEl.addEventListener('input', autoResize);

    // ── Messages from extension ──
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'connected') {
        setStatus(true, 'Connected · ' + msg.cwd);
        if (msg.conversationId) conversationId = msg.conversationId;
      }
      if (msg.type === 'disconnected') {
        setStatus(false, msg.reason || 'Disconnected');
      }
      if (msg.type === 'chunk') {
        const chunk = msg.chunk;
        if (chunk.type === 'text' && currentAssistantMsg) {
          currentAssistantMsg.textContent += chunk.content ?? '';
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        if (chunk.type === 'status') {
          appendToolStatus(chunk.content ?? '');
        }
        if (chunk.type === 'provider') {
          modelBadge.textContent = chunk.model ?? chunk.provider ?? '';
        }
        if (chunk.type === 'done' || chunk.type === 'error') {
          if (currentAssistantMsg) {
            currentAssistantMsg.classList.remove('streaming');
            if (chunk.type === 'error') {
              currentAssistantMsg.textContent = '⚠ ' + (msg.chunk.content ?? 'Error');
              currentAssistantMsg.style.color = 'var(--vscode-errorForeground, #f44336)';
            }
            currentAssistantMsg = null;
          }
          sendBtn.disabled = !connected;
          if (msg.conversationId) conversationId = msg.conversationId;
        }
      }
      if (msg.type === 'fileContext') {
        currentFile = msg.file;
        if (msg.file) {
          contextPill.style.display = 'inline-block';
          contextPill.textContent = '📎 ' + msg.file.split('/').pop();
          contextPill.title = msg.file;
        } else {
          contextPill.style.display = 'none';
        }
      }
      if (msg.type === 'inject') {
        // Inject text into the input (e.g. "Ask about file" command)
        inputEl.value = msg.text;
        autoResize();
        inputEl.focus();
      }
    });
  </script>
</body>
</html>`;
}
