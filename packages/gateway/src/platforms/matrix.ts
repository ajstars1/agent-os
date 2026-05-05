/**
 * Matrix platform adapter — uses matrix-js-sdk.
 *
 * Required env:
 *   MATRIX_HOMESERVER_URL  — e.g. https://matrix.org
 *   MATRIX_ACCESS_TOKEN    — user access token
 *   MATRIX_USER_ID         — e.g. @bot:matrix.org
 * Optional:
 *   MATRIX_ALLOWED_ROOMS   — comma-separated room IDs
 */

import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import { PlatformAdapter } from '../base.js';

export class MatrixAdapter extends PlatformAdapter {
  readonly name = 'matrix';
  private client: unknown = null;
  private allowedRooms: Set<string>;

  constructor(engine: AgentEngine, logger: Logger) {
    super(engine, logger);
    this.allowedRooms = new Set(
      (process.env['MATRIX_ALLOWED_ROOMS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  async start(): Promise<void> {
    const homeserverUrl = process.env['MATRIX_HOMESERVER_URL'];
    const accessToken = process.env['MATRIX_ACCESS_TOKEN'];
    const userId = process.env['MATRIX_USER_ID'];

    if (!homeserverUrl || !accessToken || !userId) {
      this.logger.warn('[Matrix] Missing env vars — skipping (need MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, MATRIX_USER_ID)');
      return;
    }

    try {
      const sdk = await import('matrix-js-sdk');
      const client = sdk.createClient({
        baseUrl: homeserverUrl,
        accessToken,
        userId,
        useAuthorizationHeader: true,
      });

      client.on('Room.timeline' as unknown as Parameters<typeof client.on>[0], (event: unknown) => {
        void this.handleEvent(event, userId);
      });

      await client.startClient({ initialSyncLimit: 0 });
      this.client = client;
      this.logger.info({ userId }, '[Matrix] Client started');
    } catch (err) {
      this.logger.error({ err }, '[Matrix] Failed to start — is matrix-js-sdk installed?');
    }
  }

  async stop(): Promise<void> {
    try {
      const client = this.client as { stopClient?: () => void } | null;
      client?.stopClient?.();
    } catch { /* ignore */ }
    this.client = null;
    this.logger.info('[Matrix] Stopped');
  }

  async send(roomId: string, text: string): Promise<void> {
    try {
      const client = this.client as {
        sendMessage?: (roomId: string, content: object) => Promise<unknown>;
      } | null;
      if (!client?.sendMessage) return;

      const chunks = this.chunk(text, 32_000);
      for (const chunk of chunks) {
        await client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: chunk,
          format: 'org.matrix.custom.html',
          formatted_body: chunk.replace(/\n/g, '<br>'),
        });
      }
    } catch (err) {
      this.logger.error({ err }, '[Matrix] send failed');
    }
  }

  protected get maxMessageLength(): number { return 32_000; }

  private async handleEvent(event: unknown, myUserId: string): Promise<void> {
    const e = event as {
      getType?: () => string;
      getSender?: () => string;
      getRoomId?: () => string;
      getContent?: () => { body?: string };
    };

    if (e.getType?.() !== 'm.room.message') return;
    if (e.getSender?.() === myUserId) return; // don't respond to self

    const roomId = e.getRoomId?.();
    const text = e.getContent?.().body;
    if (!roomId || !text) return;
    if (this.allowedRooms.size > 0 && !this.allowedRooms.has(roomId)) return;

    const conversationId = `matrix-room-${roomId}`;
    await this.runAndDeliver(conversationId, roomId, text);
  }
}
