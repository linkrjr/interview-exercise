import { z } from 'zod';

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export type Page<T> = { items: T[]; nextCursor: string | null };

export const MAX_PAGE_LIMIT = 100;
