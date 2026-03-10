import { type ChatInputCommandInteraction } from 'discord.js';
import type { AgentEngine } from '@agent-os/core';
import type { Logger } from '@agent-os/shared';
export declare const commandDefinitions: import("discord.js").RESTPostAPIChatInputApplicationCommandsJSONBody[];
export declare function registerCommands(token: string, clientId: string, guildId?: string, logger?: Logger): Promise<void>;
export declare function handleAsk(interaction: ChatInputCommandInteraction, engine: AgentEngine, conversationId: string, logger: Logger): Promise<void>;
export declare function handleClear(interaction: ChatInputCommandInteraction, engine: AgentEngine, conversationId: string): Promise<void>;
export declare function handleModel(interaction: ChatInputCommandInteraction): Promise<void>;
//# sourceMappingURL=index.d.ts.map