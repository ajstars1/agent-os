/**
 * AgentOS CLI — v2 UI
 *
 * Design principles:
 *  - Breathing room: generous margins, no visual clutter
 *  - The WorkerRoom panel shows live agent activity during responses
 *  - Tool calls appear as compact completed events in message history
 *  - Provider colour-coding: claude=blue, gemini=green, openrouter=yellow, ollama=magenta
 *  - GenZ agent names: nova (main), zara, echo, flux, byte...
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput, Static } from 'ink';
import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor, AgentLoader } from '@agent-os-core/core';
import { setPermissionCallback } from '@agent-os-core/core';
import type { AgentUpdate, LLMProvider, PermissionDecision } from '@agent-os-core/shared';
import { isCommand, handleCommand, type CommandContext } from '../commands/index.js';
import { PromptInput } from './PromptInput.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { MessageItem, type MessageEntry } from './MessageItem.js';
import { StatusBar } from './StatusBar.js';
import { WorkerRoom } from './WorkerRoom.js';
import { MarkdownView } from './MarkdownView.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActiveTool {
  id: string;
  name: string;
  preview: string;
  startMs: number;
}

interface KeyedMessage {
  key: string;
  msg: MessageEntry;
}

interface Props {
  engine: AgentEngine;
  skills: SkillLoader;
  channelId: string;
  hamStore?: TieredStore;
  hamCompressor?: HAMCompressor | null;
  agents?: AgentLoader;
  model: string;
  feedbackStore?: import('@agent-os-core/core').FeedbackStore;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function argPreview(input: Record<string, unknown>): string {
  const keys = ['path', 'file_path', 'command', 'pattern', 'url', 'query', 'topic', 'old_string'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') {
      const t = v.replace(/\n/g, ' ').trim();
      return t.length > 55 ? t.slice(0, 52) + '…' : t;
    }
  }
  for (const [, v] of Object.entries(input)) {
    if (typeof v === 'string') {
      const t = v.replace(/\n/g, ' ').trim();
      return t.length > 55 ? t.slice(0, 52) + '…' : t;
    }
  }
  return '';
}

function resultPreview(content: string): string {
  const first = content.split('\n').find((l) => l.trim().length > 0) ?? '';
  const t = first.trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function App({
  engine,
  skills,
  channelId,
  hamStore,
  hamCompressor,
  agents,
  model,
  feedbackStore,
}: Props): React.ReactElement {
  const { exit } = useApp();

  const conv = engine.getOrCreateConversation('cli', channelId);
  const conversationIdRef = useRef(conv.id);
  const currentModelRef = useRef({ value: model === 'auto' ? 'auto' : model });

  const [messages, setMessages] = useState<KeyedMessage[]>([]);
  const msgCountRef = useRef(0);
  const [streaming, setStreaming] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);

  // v2: live worker map (agentId → AgentUpdate)
  const [agentWorkers, setAgentWorkers] = useState<Map<string, AgentUpdate>>(new Map());
  const workerClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<'idle' | 'thinking' | 'streaming'>('idle');
  const [provider, setProvider] = useState('claude');
  const [resolvedModel, setResolvedModel] = useState('');
  const [tokenStats, setTokenStats] = useState({ input: 0, output: 0, elapsed: 0 });
  const [sessionCostUsd, setSessionCostUsd] = useState(0);
  const [lastTurnCostUsd, setLastTurnCostUsd] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [lastUserMessage, setLastUserMessage] = useState('');
  const [lastAssistantMessage, setLastAssistantMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const startMsRef = useRef(0);
  const responseMsRef = useRef(0); // when streaming started

  // ── Permission system ──────────────────────────────────────────────────────
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string;
    input: Record<string, unknown>;
    preview: string;
  } | null>(null);
  const permissionResolverRef = useRef<((d: PermissionDecision) => void) | null>(null);

  const requestPermission = useCallback(
    (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> =>
      new Promise<PermissionDecision>((resolve) => {
        const preview = (typeof input['_preview'] === 'string' ? input['_preview'] : toolName) as string;
        permissionResolverRef.current = resolve;
        setPendingPermission({ toolName, input, preview });
      }),
    [],
  );

  const handlePermissionDecision = useCallback((decision: PermissionDecision) => {
    const resolver = permissionResolverRef.current;
    permissionResolverRef.current = null;
    setPendingPermission(null);
    resolver?.(decision);
  }, []);

  useEffect(() => {
    setPermissionCallback(requestPermission);
    return () => setPermissionCallback(undefined);
  }, [requestPermission]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useInput((input, key) => {
    if (key.escape && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setStreaming('');
      setThinkingText('');
      setActiveTools([]);
      clearWorkers();
      setStatus('idle');
    } else if (key.escape) {
      exit();
      process.exit(0);
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const addMessage = useCallback((entry: MessageEntry): void => {
    const key = `msg-${msgCountRef.current++}`;
    setMessages((prev) => [...prev, { key, msg: entry }]);
  }, []);

  const clearWorkers = useCallback(() => {
    if (workerClearTimer.current) clearTimeout(workerClearTimer.current);
    workerClearTimer.current = setTimeout(() => {
      setAgentWorkers(new Map());
    }, 900);
  }, []);

  const updateWorker = useCallback((update: AgentUpdate) => {
    setAgentWorkers((prev) => {
      const next = new Map(prev);
      next.set(update.agentId, update);
      return next;
    });
  }, []);

  // Skill suggestions for status bar
  const statusBarSuggestions = React.useMemo(() => {
    if (status !== 'idle' || !lastUserMessage) return [];
    try {
      return skills.recommender.suggest(lastUserMessage, 3, 0.08).map((s) => '/' + s.name);
    } catch { return []; }
  }, [status, lastUserMessage, skills]);

  // ── Chunk handler (shared between skill and regular paths) ─────────────────
  const handleChunk = useCallback((
    chunk: Awaited<ReturnType<AgentEngine['chat']>> extends AsyncGenerator<infer T> ? T : never,
    accumulator: { text: string; provider: string },
  ) => {
    switch (chunk.type) {
      case 'provider':
        if (chunk.provider) {
          accumulator.provider = chunk.provider;
          setProvider(chunk.provider);
          if (chunk.model) setResolvedModel(chunk.model);
        }
        break;

      case 'text':
        if (chunk.content) {
          setStatus('streaming');
          accumulator.text += chunk.content;
          setStreaming(accumulator.text);
        }
        break;

      case 'thinking':
        if (chunk.content) setThinkingText((t) => t + chunk.content!);
        break;

      case 'agent_update':
        if (chunk.agentUpdate) updateWorker(chunk.agentUpdate);
        break;

      case 'tool_call':
        if (chunk.toolCall) {
          setStatus('thinking');
          const { name, id, input: ti } = chunk.toolCall;
          setActiveTools((p) => [...p, { id, name, preview: argPreview(ti), startMs: Date.now() }]);
        }
        break;

      case 'tool_result':
        if (chunk.toolResult) {
          const { toolCallId, content, isError } = chunk.toolResult;
          setActiveTools((prev) => {
            const tool = prev.find((t) => t.id === toolCallId);
            if (tool) {
              addMessage({
                type: 'tool_call',
                name: tool.name,
                preview: tool.preview,
                result: resultPreview(content),
                elapsed: Date.now() - tool.startMs,
                isError,
              });
            }
            return prev.filter((t) => t.id !== toolCallId);
          });
        }
        break;

      case 'usage':
        if (chunk.usage) {
          setTokenStats({
            input: chunk.usage.inputTokens,
            output: chunk.usage.outputTokens,
            elapsed: Date.now() - startMsRef.current,
          });
        }
        break;

      case 'status':
        if (chunk.content) addMessage({ type: 'status', text: chunk.content });
        break;

      case 'memory_saved':
        if (chunk.content) addMessage({ type: 'memory_saved', topic: chunk.content });
        break;

      case 'done':
        break;
    }
  }, [addMessage, updateWorker]);

  // ── Submit handler ─────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (input: string): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed) return;

    setHistory((h) => h[h.length - 1] === trimmed ? h : [...h, trimmed]);

    if (/^(exit|quit|q)$/i.test(trimmed)) process.exit(0);

    // ── Command / Skill ────────────────────────────────────────────────────
    if (isCommand(trimmed)) {
      const [cmdName, ...cmdRest] = trimmed.slice(1).split(' ');
      const skillContent = skills.getSkillContent(cmdName ?? '');

      if (skillContent !== null) {
        const args = cmdRest.join(' ').trim();
        const injected = skillContent.replace(/\{\{args\}\}/g, args || '(none)');
        const skillMessage = `${injected}\n\n${args ? `User args: ${args}` : ''}`.trim();

        addMessage({ type: 'user', text: trimmed });
        setLastUserMessage(trimmed);
        setStatus('thinking');
        setStreaming('');
        setActiveTools([]);
        startMsRef.current = Date.now();

        const abort = new AbortController();
        abortRef.current = abort;
        const acc = { text: '', provider: 'claude' };

        try {
          for await (const chunk of engine.chat({
            conversationId: conversationIdRef.current,
            message: skillMessage,
            forceModel: currentModelRef.current.value !== 'auto'
              ? (currentModelRef.current.value as LLMProvider)
              : undefined,
          })) {
            if (abort.signal.aborted) break;
            handleChunk(chunk as Parameters<typeof handleChunk>[0], acc);
          }
        } catch (err: unknown) {
          if (!abort.signal.aborted) {
            addMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          }
        }

        if (acc.text && !abort.signal.aborted) {
          addMessage({ type: 'assistant', text: acc.text, provider: acc.provider, elapsedMs: Date.now() - startMsRef.current });
          setLastAssistantMessage(acc.text);
        }
        finaliseResponse(abort);
        return;
      }

      // Built-in command
      const ctx: CommandContext = {
        engine, skills,
        conversationId: conversationIdRef.current,
        currentModel: currentModelRef.current,
        hamStore, hamCompressor, agents, feedbackStore,
        lastAssistantMessage,
      };
      addMessage({ type: 'user', text: trimmed });
      try {
        const output = await handleCommand(trimmed, ctx);
        if (output) addMessage({ type: 'command_output', text: output });
      } catch (err: unknown) {
        addMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── Regular message ────────────────────────────────────────────────────
    addMessage({ type: 'user', text: trimmed });
    setLastUserMessage(trimmed);
    setStatus('thinking');
    setStreaming('');
    setActiveTools([]);
    startMsRef.current = Date.now();
    responseMsRef.current = 0;

    const forceModel = currentModelRef.current.value !== 'auto'
      ? (currentModelRef.current.value as LLMProvider)
      : undefined;

    const abort = new AbortController();
    abortRef.current = abort;
    const acc = { text: '', provider: 'claude' };

    try {
      for await (const chunk of engine.chat({
        conversationId: conversationIdRef.current,
        message: trimmed,
        forceModel,
      })) {
        if (abort.signal.aborted) break;
        if (chunk.type === 'text' && !responseMsRef.current) responseMsRef.current = Date.now();
        handleChunk(chunk as Parameters<typeof handleChunk>[0], acc);
      }
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        addMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    if (acc.text && !abort.signal.aborted) {
      addMessage({
        type: 'assistant',
        text: acc.text,
        provider: acc.provider,
        model: resolvedModel || undefined,
        elapsedMs: responseMsRef.current ? Date.now() - responseMsRef.current : undefined,
      });
      setLastAssistantMessage(acc.text);
    }

    finaliseResponse(abort);
  }, [engine, skills, hamStore, hamCompressor, agents, feedbackStore, lastAssistantMessage, addMessage, clearWorkers, handleChunk, resolvedModel]);

  const finaliseResponse = (abort: AbortController): void => {
    setStreaming('');
    setThinkingText('');
    setActiveTools([]);
    setStatus('idle');
    setTokenStats((p) => ({ ...p, elapsed: Date.now() - startMsRef.current }));
    abortRef.current = null;
    clearWorkers();
    if (!abort.signal.aborted) {
      // Inline reset so it doesn't depend on stale state
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {/* ── Message history — append-only via Static ── */}
      <Static items={messages}>
        {(item) => <MessageItem key={item.key} message={item.msg} />}
      </Static>

      {/* ── Live thinking block ── */}
      {thinkingText && status !== 'idle' && (
        <Box
          flexDirection="column"
          marginTop={1}
          marginLeft={1}
          borderStyle="single"
          borderColor="dim"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          paddingLeft={1}
        >
          <Text dimColor bold>◈ thinking</Text>
          {thinkingText.split('\n').slice(-8).map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      )}

      {/* ── Live streaming text ── */}
      {streaming && (
        <Box
          flexDirection="column"
          marginTop={1}
          marginLeft={1}
          borderStyle="round"
          borderColor={provider === 'gemini' ? 'green' : provider === 'ollama' ? 'magenta' : provider === 'openrouter' ? 'yellow' : 'blueBright'}
          paddingX={1}
        >
          <Box marginBottom={1}>
            <Text dimColor>✦ </Text>
            <Text bold dimColor>{resolvedModel || provider}</Text>
            <Text dimColor> · responding…</Text>
          </Box>
          <Box flexDirection="column">
            {streaming.split('\n').slice(-30).map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        </Box>
      )}

      {/* ── WorkerRoom — live crew panel ── */}
      <WorkerRoom workers={agentWorkers} sessionCostUsd={sessionCostUsd > 0 ? sessionCostUsd : undefined} />

      {/* ── In-flight tool calls (shown until tool_result arrives) ── */}
      {activeTools.length > 0 && agentWorkers.size === 0 && (
        <Box flexDirection="column" marginTop={0} marginLeft={3}>
          {activeTools.map((tool) => (
            <Box key={tool.id}>
              <Text dimColor>⚡ </Text>
              <Text dimColor bold>{tool.name}</Text>
              {tool.preview ? <Text dimColor>  {tool.preview}</Text> : null}
            </Box>
          ))}
        </Box>
      )}

      {/* ── Permission prompt ── */}
      {pendingPermission && (
        <PermissionPrompt
          toolName={pendingPermission.toolName}
          input={pendingPermission.input}
          preview={pendingPermission.preview}
          onDecision={handlePermissionDecision}
        />
      )}

      {/* ── Status bar ── */}
      <StatusBar
        status={status}
        provider={provider}
        resolvedModel={resolvedModel}
        inputTokens={tokenStats.input}
        outputTokens={tokenStats.output}
        finalElapsedMs={tokenStats.elapsed}
        activeStartMs={startMsRef.current}
        cwd={process.cwd()}
        skillSuggestions={statusBarSuggestions}
        isPlanning={engine.planningManager.getMode() === 'plan'}
        lastTurnCost={lastTurnCostUsd > 0 ? lastTurnCostUsd : undefined}
        sessionCost={sessionCostUsd > 0 ? sessionCostUsd : undefined}
      />

      {/* ── Input ── */}
      <PromptInput
        onSubmit={(v) => handleSubmit(v)}
        history={history}
        isDisabled={status !== 'idle' || pendingPermission !== null}
        commands={skills.getSkillNames().map((n) => '/' + n)}
      />
    </Box>
  );
}
