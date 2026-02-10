import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isPretty = process.stdout.isTTY;

export const logger = pino(
  {
    level,
    redact: {
      paths: [
        'PRIVATE_KEY',
        '*.PRIVATE_KEY',
        'POLY_API_SECRET',
        '*.POLY_API_SECRET',
        'secret',
        '*.secret',
        'passphrase',
        '*.passphrase',
      ],
      remove: true,
    },
  },
  isPretty
    ? (await import('pino-pretty')).default({ colorize: true })
    : undefined
);
