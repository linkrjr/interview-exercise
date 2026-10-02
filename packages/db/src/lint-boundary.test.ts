import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function ruleIds(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}${file}` });
  return result!.messages.map((m) => m.ruleId ?? 'parse-error');
}

describe('raw database connection boundary', () => {
  it.each([
    ["import { Pool } from 'pg';", 'packages/core/src/x.ts'],
    ["import pg from 'pg';", 'packages/api/src/x.ts'],
    ["import { drizzle } from 'drizzle-orm/node-postgres';", 'packages/scheduler/src/x.ts'],
    ["import { createDb } from '../../db/src/client.js';", 'packages/core/src/x.ts'],
  ])('forbids %s outside packages/db', async (code, file) => {
    expect(await ruleIds(code, file)).toContain('no-restricted-imports');
  });

  it('allows the same imports inside packages/db', async () => {
    expect(await ruleIds("import { Pool } from 'pg';\nvoid Pool;", 'packages/db/src/x.ts')).toEqual(
      [],
    );
  });

  it('allows importing the public @mc/db API from other packages', async () => {
    expect(
      await ruleIds("import { createDb } from '@mc/db';\nvoid createDb;", 'packages/core/src/x.ts'),
    ).toEqual([]);
  });
});

describe('the pure matcher engine', () => {
  it.each([
    ["import { readFileSync } from 'node:fs';", 'packages/matcher/src/engine.ts'],
    ["import { createHash } from 'crypto';", 'packages/matcher/src/explain.ts'],
    ["import { createDb } from '@mc/db';", 'packages/matcher/src/context.ts'],
    ["import { missions } from '@mc/core';", 'packages/matcher/src/exact.ts'],
    ["import highs from 'highs';", 'packages/matcher/src/model.ts'],
    ["import { Pool } from 'pg';", 'packages/matcher/src/model.ts'],
    ['void process.env;', 'packages/matcher/src/engine.ts'],
    ["void Buffer.from('x');", 'packages/matcher/src/engine.ts'],
  ])('forbids %s in the engine', async (code, file) => {
    const ids = await ruleIds(code, file);
    expect(ids.some((id) => id === 'no-restricted-imports' || id === 'no-restricted-globals')).toBe(
      true,
    );
  });

  it('allows the HiGHS adapter and the tests to load the runtime and use Node', async () => {
    expect(
      await ruleIds("import highs from 'highs';\nvoid highs;", 'packages/matcher/src/highs.ts'),
    ).toEqual([]);
    expect(
      await ruleIds(
        "import { readFileSync } from 'node:fs';\nvoid readFileSync;",
        'packages/matcher/src/engine.test.ts',
      ),
    ).toEqual([]);
    expect(
      await ruleIds(
        "import { highs } from './highs.js';\nvoid highs;",
        'packages/matcher/src/test-support.ts',
      ),
    ).toEqual([]);
  });

  it('allows the engine to import its own modules', async () => {
    expect(
      await ruleIds(
        "import { prepare } from './context.js';\nvoid prepare;",
        'packages/matcher/src/engine.ts',
      ),
    ).toEqual([]);
  });
});
