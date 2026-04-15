import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, Static } from 'ink';
import type { AgentEngine, SkillLoader, TieredStore, HAMCompressor, AgentLoader } from '@agent-os/core';
import type { LLMProvider } from '@agent-os/shared';
import { isCommand, handleCommand, type CommandContext } from '../commands/index.js';
import { PromptInput } from './PromptInput.js';
import { MessageItem, type MessageEntry } from './MessageItem.js';
import { StatusBar } from './StatusBar.js';
import { renderMarkdown } from './markdown.js';

interface ActiveTool {
  id: string;
  name: string;
  preview: string;
  startMs: number;
}

interface Props {
  engine: AgentEngine;
  skills: SkillLoader;
  channelId: string;
  hamStore?: TieredStore;
  hamCompressor?: HAMCompressor | null;
  agents?: AgentLoader;
  model: string;
}

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

// Wrap each message with a stable string key for Static
interface KeyedMessage {
  key: string;
  msg: MessageEntry;
}

export function App({
  engine,
  skills,
  channelId,
  hamStore,
  hamCompressor,
  agents,
  model,
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
  const [status, setStatus] = useState<'idle' | 'thinking' | 'streaming'>('idle');
  const [provider, setProvider] = useState('claude');
  const [resolvedModel, setResolvedModel] = useState('');
  const [tokenStats, setTokenStats] = useState({ input: 0, output: 0, elapsed: 0 });
  const [history, setHistory] = useState<string[]>([]);
  const [lastUserMessage, setLastUserMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const startMsRef = useRef(0);

  // Ctrl+C: abort stream if running, else exit
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        setStatus('idle');
        setStreaming('');
        setActiveTools([]);
      } else {
        exit();
        process.exit(0);
      }
    }
  });

  // Post-response skill suggestions from TF-IDF recommender
  const statusBarSuggestions = React.useMemo(() => {
    if (status !== 'idle' || !lastUserMessage) return [];
    try {
      return skills.recommender.suggest(lastUserMessage, 3, 0.08).map((s) => '/' + s.name);
    } catch {
      return [];
    }
  }, [status, lastUserMessage, skills]);

  // Extract skill names from system context for command suggestions
  const skillNames = React.useMemo(() => {
    const ctx = skills.getSystemContext();
    return ctx.split('# Skill:')
      .slice(1)
      .map((s) => s.split('\n')[0]?.trim() ?? '')
      .filter(Boolean);
  }, [skills]);

  const addMessage = useCallback((entry: MessageEntry): void => {
    const key = `msg-${msgCountRef.current++}`;
    setMessages((prev) => [...prev, { key, msg: entry }]);
  }, []);

  const handleSubmit = useCallback(async (input: string): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed) return;

    setHistory((h) => {
      if (h[h.length - 1] === trimmed) return h;
      return [...h, trimmed];
    });

    if (isCommand(trimmed)) {
      // Check built-in commands first
      const [cmdName, ...cmdRest] = trimmed.slice(1).split(' ');
      const skillContent = skills.getSkillContent(cmdName ?? '');

      if (skillContent !== null) {
        // Skill invocation — inject full skill content as system-level context for this turn
        const args = cmdRest.join(' ').trim();
        const injected = skillContent.replace(/\{\{args\}\}/g, args || '(none)');
        const skillMessage = `${injected}\n\n${args ? `User args: ${args}` : ''}`.trim();

        addMessage({ type: 'user', text: trimmed });
        setLastUserMessage(trimmed);
        setStatus('thinking');
        setStreaming('');
        setActiveTools([]);
        startMsRef.current = Date.now();

        const forceModel = currentModelRef.current.value !== 'auto'
          ? (currentModelRef.current.value as LLMProvider)
          : undefined;

        const abort = new AbortController();
        abortRef.current = abort;
        const { signal } = abort;
        let accumulatedText = '';
        let currentProvider = 'claude';

        try {
          for await (const chunk of engine.chat({
            conversationId: conversationIdRef.current,
            message: skillMessage,
            forceModel,
          })) {
            if (signal.aborted) break;
            switch (chunk.type) {
              case 'provider': if (chunk.provider) { currentProvider = chunk.provider; setProvider(chunk.provider); if (chunk.model) setResolvedModel(chunk.model); } break;
              case 'text': if (chunk.content) { setStatus('streaming'); accumulatedText += chunk.content; setStreaming(accumulatedText); } break;
              case 'thinking': if (chunk.content) { setThinkingText((t) => t + chunk.content!); } break;
              case 'tool_call': if (chunk.toolCall) { setStatus('thinking'); const { name, id, input: ti } = chunk.toolCall; setActiveTools((p) => [...p, { id, name, preview: argPreview(ti), startMs: Date.now() }]); } break;
              case 'tool_result': if (chunk.toolResult) { const { toolCallId, content, isError } = chunk.toolResult; setActiveTools((p) => { const t = p.find((x) => x.id === toolCallId); if (t) addMessage({ type: 'tool_call', name: t.name, preview: t.preview, result: resultPreview(content), elapsed: Date.now() - t.startMs, isError }); return p.filter((x) => x.id !== toolCallId); }); } break;
              case 'usage': if (chunk.usage) setTokenStats({ input: chunk.usage.inputTokens, output: chunk.usage.outputTokens, elapsed: Date.now() - startMsRef.current }); break;
              case 'memory_saved': if (chunk.content) addMessage({ type: 'memory_saved', topic: chunk.content }); break;
              case 'done': break;
            }
          }
        } catch (err: unknown) {
          if (!signal.aborted) addMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }

        if (accumulatedText && !signal.aborted) addMessage({ type: 'assistant', text: accumulatedText, provider: currentProvider });
        setStreaming('');
        setThinkingText((t) => {
          if (t && !signal.aborted) addMessage({ type: 'thinking', text: t });
          return '';
        });
        setActiveTools([]); setStatus('idle');
        setTokenStats((p) => ({ ...p, elapsed: Date.now() - startMsRef.current }));
        abortRef.current = null;
        return;
      }

      const ctx: CommandContext = {
        engine,
        skills,
        conversationId: conversationIdRef.current,
        currentModel: currentModelRef.current,
        hamStore,
        hamCompressor,
        agents,
      };
      addMessage({ type: 'user', text: trimmed });
      try {
        const output = await handleCommand(trimmed, ctx);
        if (output) addMessage({ type: 'command_output', text: output });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addMessage({ type: 'error', message: msg });
      }
      return;
    }

    addMessage({ type: 'user', text: trimmed });
    setLastUserMessage(trimmed);
    setStatus('thinking');
    setStreaming('');
    setActiveTools([]);
    startMsRef.current = Date.now();

    const forceModel = currentModelRef.current.value !== 'auto'
      ? (currentModelRef.current.value as LLMProvider)
      : undefined;

    const abort = new AbortController();
    abortRef.current = abort;
    const { signal } = abort;

    let accumulatedText = '';
    let currentProvider = 'claude';

    try {
      for await (const chunk of engine.chat({
        conversationId: conversationIdRef.current,
        message: trimmed,
        forceModel,
      })) {
        if (signal.aborted) break;

        switch (chunk.type) {
          case 'provider':
            if (chunk.provider) {
              currentProvider = chunk.provider;
              setProvider(chunk.provider);
              if (chunk.model) setResolvedModel(chunk.model);
            }
            break;

          case 'text':
            if (chunk.content) {
              setStatus('streaming');
              accumulatedText += chunk.content;
              setStreaming(accumulatedText);
            }
            break;

          case 'thinking':
            if (chunk.content) {
              setThinkingText((t) => t + chunk.content!);
            }
            break;

          case 'tool_call':
            if (chunk.toolCall) {
              setStatus('thinking');
              const { name, id, input: toolInput } = chunk.toolCall;
              const preview = argPreview(toolInput);
              setActiveTools((prev) => [...prev, { id, name, preview, startMs: Date.now() }]);
            }
            break;

          case 'tool_result':
            if (chunk.toolResult) {
              const { toolCallId, content, isError } = chunk.toolResult;
              setActiveTools((prev) => {
                const tool = prev.find((t) => t.id === toolCallId);
                if (tool) {
                  const elapsed = Date.now() - tool.startMs;
                  addMessage({
                    type: 'tool_call',
                    name: tool.name,
                    preview: tool.preview,
                    result: resultPreview(content),
                    elapsed,
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

          case 'memory_saved':
            if (chunk.content) {
              addMessage({ type: 'memory_saved', topic: chunk.content });
            }
            break;

          case 'done':
            break;
        }
      }
    } catch (err: unknown) {
      if (!signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        addMessage({ type: 'error', message: msg });
      }
    }

    if (accumulatedText && !signal.aborted) {
      addMessage({ type: 'assistant', text: accumulatedText, provider: currentProvider });
    }

    setStreaming('');
    setThinkingText((t) => {
      if (t && !signal.aborted) addMessage({ type: 'thinking', text: t });
      return '';
    });
    setActiveTools([]);
    setStatus('idle');
    setTokenStats((prev) => ({ ...prev, elapsed: Date.now() - startMsRef.current }));
    abortRef.current = null;
  }, [engine, skills, hamStore, hamCompressor, agents, addMessage]);

  return (
    <Box flexDirection="column">
      {/* Message history — append-only via Static */}
      <Static items={messages}>
        {(item) => (
          <MessageItem key={item.key} message={item.msg} />
        )}
      </Static>

      {/* Live thinking block */}
      {thinkingText && status !== 'idle' && (
        <Box flexDirection="column" marginLeft={2} marginBottom={0}>
          <Text color="yellow" dimColor>{'  ◐ thinking…'}</Text>
          {thinkingText.split('\n').slice(-4).map((line, i) => (
            <Text key={i} dimColor>{`    ${line}`}</Text>
          ))}
        </Box>
      )}

      {/* Live streaming text */}
      {streaming && (
        <Box flexDirection="column" paddingLeft={2}>
          {renderMarkdown(streaming).split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}

      {/* Active tool calls */}
      {activeTools.map((tool) => (
        <Box key={tool.id} marginLeft={2}>
          <Text color="cyan">{'  ⠿ '}</Text>
          <Text color="cyan">{tool.name}</Text>
          {tool.preview ? <Text dimColor>{'  '}{tool.preview}</Text> : null}
        </Box>
      ))}

      {/* Status bar */}
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
      />

      {/* Input prompt */}
      <PromptInput
        onSubmit={(val) => { void handleSubmit(val); }}
        isDisabled={status !== 'idle'}
        commands={skillNames}
        history={history}
      />
    </Box>
  );
}
