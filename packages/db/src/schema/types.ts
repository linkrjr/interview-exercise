import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/** `daterange` in its canonical Postgres text form, e.g. `[2026-11-02,2026-11-21)`. */
export const daterange = customType<{ data: string }>({
  dataType: () => 'daterange',
});

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Columns shared by every table: see DESIGN.md §15. */
export const timestamps = {
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
};

export const orgId = () => uuid('org_id').notNull();
