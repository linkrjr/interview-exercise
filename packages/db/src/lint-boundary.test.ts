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
