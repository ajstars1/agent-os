const MAX_TOOL_ITERATIONS = 10;
export class AgentEngine {
    config;
    memory;
    skills;
    tools;
    claude;
    gemini;
    router;
    logger;
    hamRetriever;
    hamStore;
    constructor(config, memory, skills, tools, claude, gemini, router, logger, hamRetriever, hamStore) {
        this.config = config;
        this.memory = memory;
        this.skills = skills;
        this.tools = tools;
        this.claude = claude;
        this.gemini = gemini;
        this.router = router;
        this.logger = logger;
        this.hamRetriever = hamRetriever;
        this.hamStore = hamStore;
    }
    getOrCreateConversation(channel, channelId) {
        return this.memory.getOrCreateConversation(channel, channelId);
    }
    clearConversation(conversationId) {
        this.memory.clearConversation(conversationId);
    }
    async *chat(input) {
        const cleanedMessage = this.router.stripPrefix(input.message);
        const effectiveModel = input.forceModel ?? input.agentProfile?.defaultModel;
        const provider = await this.router.route(input.message, effectiveModel);
        // Store user message first so history is current for HAM retrieval
        this.memory.addMessage(input.conversationId, {
            conversationId: input.conversationId,
            role: 'user',
            content: cleanedMessage,
        });
        // Build message history
        const history = this.memory.getMessages(input.conversationId, 50);
        // HAM retrieval — prepend adaptive memory to system prompt
        const hamResult = this.hamRetriever?.retrieve(cleanedMessage, history, input.conversationId);
        const baseContext = this.skills.getSystemContext();
        let systemPrompt = input.agentProfile?.systemPrompt
            ? `${input.agentProfile.systemPrompt}\n\n---\n\n${baseContext}`
            : baseContext;
        if (hamResult?.activeMemory) {
            systemPrompt = `${hamResult.activeMemory}\n\n---\n\n${systemPrompt}`;
            this.logger.debug({ state: hamResult.state, tokens: hamResult.tokenCount, topics: hamResult.expandedTopics }, 'HAM retrieval complete');
        }
        const toolDefs = this.tools.getTools();
        if (provider === 'claude') {
            yield* this.claudeLoop(input.conversationId, history, systemPrompt, toolDefs, cleanedMessage);
        }
        else {
            yield* this.geminiStream(input.conversationId, history, systemPrompt, cleanedMessage);
        }
        // Update HAM access stats after response
        if (hamResult?.usedChunkIds.length && this.hamStore) {
            for (const id of hamResult.usedChunkIds) {
                this.hamStore.updateAccessStats(id);
            }
        }
    }
    async *claudeLoop(conversationId, history, systemPrompt, toolDefs, lastUserMessage) {
        const messages = history
            .slice(0, -1) // exclude last user message (already in history), we'll add it
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
            role: m.role,
            content: m.content,
        }));
        // Add the current user message
        messages.push({ role: 'user', content: lastUserMessage });
        let iteration = 0;
        let fullAssistantText = '';
        let lastUsage = { inputTokens: 0, outputTokens: 0 };
        while (iteration < MAX_TOOL_ITERATIONS) {
            const pendingToolCalls = [];
            let iterText = '';
            for await (const chunk of this.claude.stream(messages, systemPrompt, toolDefs)) {
                if (chunk.type === 'text' && chunk.content) {
                    iterText += chunk.content;
                    yield chunk;
                }
                else if (chunk.type === 'tool_call' && chunk.toolCall) {
                    pendingToolCalls.push(chunk.toolCall);
                    yield chunk;
                }
                else if (chunk.type === 'usage' && chunk.usage) {
                    lastUsage = chunk.usage;
                    yield chunk;
                }
                else if (chunk.type === 'done') {
                    break;
                }
            }
            fullAssistantText += iterText;
            if (pendingToolCalls.length === 0) {
                // No tool calls — we're done
                break;
            }
            // Execute tool calls
            const toolResults = [];
            for (const toolCall of pendingToolCalls) {
                this.logger.debug({ tool: toolCall.name }, 'Calling tool');
                const result = await this.tools.callTool(toolCall.name, toolCall.input);
                result.toolCallId = toolCall.id;
                toolResults.push(result);
                yield { type: 'tool_result', toolResult: result };
            }
            // Build Claude tool use + tool result messages
            const assistantContent = [];
            if (iterText) {
                assistantContent.push({ type: 'text', text: iterText });
            }
            for (const tc of pendingToolCalls) {
                assistantContent.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input: tc.input,
                });
            }
            messages.push({ role: 'assistant', content: assistantContent });
            const toolResultContent = toolResults.map((r) => ({
                type: 'tool_result',
                tool_use_id: r.toolCallId,
                content: r.content,
                ...(r.isError ? { is_error: true } : {}),
            }));
            messages.push({ role: 'user', content: toolResultContent });
            iteration++;
        }
        if (iteration >= MAX_TOOL_ITERATIONS) {
            this.logger.warn({ conversationId }, 'Hit max tool iterations');
        }
        // Persist assistant message
        if (fullAssistantText) {
            this.memory.addMessage(conversationId, {
                conversationId,
                role: 'assistant',
                content: fullAssistantText,
                model: 'claude',
                tokens: lastUsage.inputTokens + lastUsage.outputTokens,
            });
        }
        yield { type: 'done' };
    }
    async *geminiStream(conversationId, history, systemPrompt, lastUserMessage) {
        if (!this.gemini) {
            yield { type: 'text', content: 'Gemini client not configured.' };
            yield { type: 'done' };
            return;
        }
        const geminiMessages = history
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));
        // Ensure last message is the current user input
        if (geminiMessages.length === 0 || geminiMessages[geminiMessages.length - 1]?.role !== 'user') {
            geminiMessages.push({ role: 'user', parts: [{ text: lastUserMessage }] });
        }
        let fullText = '';
        let lastUsage = { inputTokens: 0, outputTokens: 0 };
        for await (const chunk of this.gemini.stream(geminiMessages, systemPrompt)) {
            if (chunk.type === 'text' && chunk.content) {
                fullText += chunk.content;
                yield chunk;
            }
            else if (chunk.type === 'usage' && chunk.usage) {
                lastUsage = chunk.usage;
                yield chunk;
            }
            else if (chunk.type === 'done') {
                break;
            }
        }
        if (fullText) {
            this.memory.addMessage(conversationId, {
                conversationId,
                role: 'assistant',
                content: fullText,
                model: 'gemini',
                tokens: lastUsage.inputTokens + lastUsage.outputTokens,
            });
        }
        yield { type: 'done' };
    }
}
//# sourceMappingURL=engine.js.map