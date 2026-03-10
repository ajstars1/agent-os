import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(name: string, level = 'info'): Logger {
  return pino({
    name,
    level,
    ...(process.env['NODE_ENV'] !== 'production'
      ? {
          transport: {
            target: 'pino/file',
            options: { destination: 1 },
          },
        }
      : {}),
  });
}
