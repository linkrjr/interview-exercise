/** Minimal structured logger; Fastify's logger satisfies it. Never log secrets or raw emails. */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined };
