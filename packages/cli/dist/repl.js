import * as readline from 'node:readline/promises';
import { isCommand, handleCommand } from './commands/index.js';
const PROMPT = '\x1b[36m>\x1b[0m ';
export class Repl {
    engine;
    skills;
    hamStore;
    hamCompressor;
    rl;
    currentModel = { value: 'auto' };
    conversationId;
    constructor(engine, skills, channelId, hamStore, hamCompressor) {
        this.engine = engine;
        this.skills = skills;
        this.hamStore = hamStore;
        this.hamCompressor = hamCompressor;
        const conv = engine.getOrCreateConversation('cli', channelId);
        this.conversationId = conv.id;
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });
        this.rl.on('SIGINT', () => {
            process.stdout.write('\nGoodbye.\n');
            this.rl.close();
            process.exit(0);
        });
    }
    async run() {
        process.stdout.write('\x1b[1mAgentOS\x1b[0m — type /help for commands\n\n');
        while (true) {
            let input;
            try {
                input = await this.rl.question(PROMPT);
            }
            catch {
                break;
            }
            const trimmed = input.trim();
            if (!trimmed)
                continue;
            if (isCommand(trimmed)) {
                const ctx = {
                    engine: this.engine,
                    skills: this.skills,
                    conversationId: this.conversationId,
                    currentModel: this.currentModel,
                    hamStore: this.hamStore,
                    hamCompressor: this.hamCompressor,
                };
                await handleCommand(trimmed, ctx);
                continue;
            }
            await this.chat(trimmed);
        }
    }
    async chat(message) {
        const forceModel = this.currentModel.value !== 'auto'
            ? this.currentModel.value
            : undefined;
        let inputTokens = 0;
        let outputTokens = 0;
        let usedModel = 'claude';
        let hasOutput = false;
        try {
            for await (const chunk of this.engine.chat({
                conversationId: this.conversationId,
                message,
                forceModel,
            })) {
                if (chunk.type === 'text' && chunk.content) {
                    process.stdout.write(chunk.content);
                    hasOutput = true;
                }
                else if (chunk.type === 'usage' && chunk.usage) {
                    inputTokens = chunk.usage.inputTokens;
                    outputTokens = chunk.usage.outputTokens;
                }
                else if (chunk.type === 'tool_call' && chunk.toolCall) {
                    process.stdout.write(`\n\x1b[2m[calling tool: ${chunk.toolCall.name}]\x1b[0m\n`);
                }
                else if (chunk.type === 'done') {
                    break;
                }
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stdout.write(`\n\x1b[31mError: ${message}\x1b[0m\n`);
            return;
        }
        if (hasOutput) {
            process.stdout.write(`\n\n\x1b[2m[model: ${usedModel} | in: ${inputTokens} out: ${outputTokens} tokens]\x1b[0m\n`);
        }
    }
}
//# sourceMappingURL=repl.js.map