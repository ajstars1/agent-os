/**
 * AgentOS VS Code Extension
 *
 * Activates on startup, registers the chat sidebar panel, and bridges
 * communication between VS Code and the local AgentOS bridge server.
 *
 * Setup for the user:
 *   1. Start: `aos-web` (or `aos` + web server)
 *   2. The bridge server listens on port 7878 (configurable)
 *   3. Open the AgentOS sidebar in VS Code — it connects automatically
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { BridgeClient, defaultSecretPath } from './bridgeClient.js';
import { getChatHtml } from './webviewHtml.js';

// ─── State ────────────────────────────────────────────────────────────────────

let client: BridgeClient | null = null;
let chatProvider: ChatViewProvider | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export function activate(ctx: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration('agentOS');
  const bridgeUrl: string = cfg.get('bridgeUrl') ?? 'http://localhost:7878';
  const secretFile: string = defaultSecretPath(cfg.get('secretFile') ?? '');

  client = new BridgeClient(bridgeUrl, secretFile);

  // Status bar indicator
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(robot) AgentOS';
  statusBarItem.tooltip = 'AgentOS — click to open chat';
  statusBarItem.command = 'agentOS.openChat';
  statusBarItem.show();
  ctx.subscriptions.push(statusBarItem);

  // Sidebar chat panel
  chatProvider = new ChatViewProvider(ctx.extensionUri, client);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentOS.chat', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('agentOS.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.agent-os');
    }),

    vscode.commands.registerCommand('agentOS.askAboutFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showInformationMessage('No active file'); return; }
      const fileName = editor.document.fileName.split('/').pop() ?? 'this file';
      chatProvider?.injectMessage(`Explain the code in ${fileName} — what does it do and are there any issues?`);
    }),

    vscode.commands.registerCommand('agentOS.explainSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('Select code first');
        return;
      }
      const selected = editor.document.getText(editor.selection);
      chatProvider?.injectMessage(`Explain this code:\n\`\`\`\n${selected.slice(0, 2000)}\n\`\`\``);
    }),

    vscode.commands.registerCommand('agentOS.reconnect', () => {
      client?.invalidateSecret();
      chatProvider?.connect();
    }),
  );

  // Push file context whenever the active editor changes
  const pushContext = (): void => { chatProvider?.pushFileContext(); };
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(pushContext),
    vscode.window.onDidChangeTextEditorSelection(pushContext),
  );

  // Auto-connect if configured
  if (cfg.get('autoConnect') !== false) {
    chatProvider.connect();
  }
}

export function deactivate(): void {
  statusBarItem?.dispose();
}

// ─── Chat View Provider ───────────────────────────────────────────────────────

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private conversationId?: string;
  private connected = false;
  private abortController?: AbortController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: BridgeClient,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    const nonce = crypto.randomBytes(16).toString('hex');
    webviewView.webview.html = getChatHtml(nonce, webviewView.webview.cspSource);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; message?: string; conversationId?: string }) => {
      if (msg.type === 'send' && msg.message) {
        await this.handleSend(msg.message, msg.conversationId);
      }
    });

    // Connect on first panel open
    if (!this.connected) this.connect();
  }

  async connect(): Promise<void> {
    if (!this.view) return;

    try {
      const status = await this.bridge.status();
      this.connected = true;
      this.view.webview.postMessage({
        type: 'connected',
        cwd: status.cwd,
        conversationId: this.conversationId,
      });
      statusBarItem!.text = '$(robot) AgentOS ●';
      statusBarItem!.tooltip = `AgentOS — connected · ${status.cwd}`;
      this.pushFileContext();
    } catch (err) {
      this.connected = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.view.webview.postMessage({ type: 'disconnected', reason: msg });
      statusBarItem!.text = '$(robot) AgentOS ○';
      statusBarItem!.tooltip = `AgentOS — disconnected: ${msg}`;
    }
  }

  pushFileContext(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.view) return;

    const cfg = vscode.workspace.getConfiguration('agentOS');
    if (!cfg.get('includeFileContext')) return;

    const doc = editor.document;
    const sel = editor.selection;
    const visibleRanges = editor.visibleRanges;

    const ctx = {
      file: doc.fileName,
      language: doc.languageId,
      selection: sel.isEmpty ? undefined : doc.getText(sel),
      visibleRange: visibleRanges.length > 0
        ? `L${visibleRanges[0]!.start.line + 1}–L${visibleRanges[0]!.end.line + 1}`
        : undefined,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    };

    // Push to bridge (best-effort — don't await, don't throw)
    this.bridge.pushContext(ctx).catch(() => { /* ignore */ });

    // Notify webview so it can show the context pill
    this.view.webview.postMessage({
      type: 'fileContext',
      file: doc.fileName,
    });
  }

  injectMessage(text: string): void {
    // Focus the sidebar then inject the message into the input
    vscode.commands.executeCommand('workbench.view.extension.agent-os');
    setTimeout(() => {
      this.view?.webview.postMessage({ type: 'inject', text });
    }, 300);
  }

  private async handleSend(message: string, existingConvId?: string): Promise<void> {
    if (!this.view) return;

    // Cancel any in-progress stream
    this.abortController?.abort();
    this.abortController = new AbortController();

    if (!this.connected) {
      await this.connect();
      if (!this.connected) return;
    }

    const convId = existingConvId ?? this.conversationId;
    const cfg = vscode.workspace.getConfiguration('agentOS');
    const includeCtx = cfg.get<boolean>('includeFileContext') ?? true;

    const view = this.view;

    try {
      await this.bridge.streamChat(
        message,
        convId,
        includeCtx,
        (chunk) => {
          view.webview.postMessage({ type: 'chunk', chunk });
          if (chunk.type === 'done') {
            this.conversationId = convId;
          }
        },
        this.abortController.signal,
      );
    } catch (err) {
      if ((err as Error).message === 'Aborted') return;
      const msg = err instanceof Error ? err.message : String(err);
      view.webview.postMessage({
        type: 'chunk',
        chunk: { type: 'error', content: msg },
      });
      // If auth failure, try reconnecting
      if (msg.includes('401') || msg.includes('secret')) {
        this.connected = false;
        this.connect();
      }
    }
  }
}
