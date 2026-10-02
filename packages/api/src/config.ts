import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool,
  DATABASE_URL_TENANT: z.string().min(1),
  DATABASE_URL_PLATFORM: z.string().min(1),
  PLATFORM_OPERATOR_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  LOGIN_RATE_EMAIL_MAX: z.coerce.number().int().min(1).default(5),
  LOGIN_RATE_IP_MAX: z.coerce.number().int().min(1).default(20),
  LOGIN_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean;
  tenantUrl: string;
  platformUrl: string;
  operatorToken: string;
  /** PEM keys, or `undefined` to generate an ephemeral pair (development and tests only). */
  jwtPrivateKey: string | undefined;
  jwtPublicKey: string | undefined;
  loginRate: { emailMax: number; ipMax: number; windowMs: number };
}

/** PEM keys in environment variables often carry literal `\n` sequences. */
const unescapePem = (value: string | undefined) => value?.replace(/\\n/g, '\n');

/** Validates the environment and fails with every problem at once (DESIGN.md §12). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  const privateKey = unescapePem(e.JWT_PRIVATE_KEY);
  const publicKey = unescapePem(e.JWT_PUBLIC_KEY);
  if (Boolean(privateKey) !== Boolean(publicKey)) {
    throw new Error(
      'Invalid configuration:\n  JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be set together',
    );
  }
  if (e.NODE_ENV === 'production' && !privateKey) {
    throw new Error(
      'Invalid configuration:\n  JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production',
    );
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY ?? false,
    tenantUrl: e.DATABASE_URL_TENANT,
    platformUrl: e.DATABASE_URL_PLATFORM,
    operatorToken: e.PLATFORM_OPERATOR_TOKEN,
    jwtPrivateKey: privateKey,
    jwtPublicKey: publicKey,
    loginRate: {
      emailMax: e.LOGIN_RATE_EMAIL_MAX,
      ipMax: e.LOGIN_RATE_IP_MAX,
      windowMs: e.LOGIN_RATE_WINDOW_SECONDS * 1000,
    },
  };
}
