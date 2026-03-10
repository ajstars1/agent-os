import pino from 'pino';
export function createLogger(name, level = 'info') {
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
//# sourceMappingURL=index.js.map