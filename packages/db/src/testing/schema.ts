import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index.js';

export interface DefinedTable {
  name: string;
  columns: Array<{ name: string; notNull: boolean }>;
}

/** Every table described by the Drizzle schema. */
export function definedTables(): DefinedTable[] {
  const tables: DefinedTable[] = [];
  for (const value of Object.values(schema) as unknown[]) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    tables.push({
      name: config.name,
      columns: config.columns.map((c) => ({ name: c.name, notNull: c.notNull })),
    });
  }
  return tables;
}
