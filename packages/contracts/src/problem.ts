import { z } from 'zod';

export const FieldErrorSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

/** RFC 9457 `application/problem+json` body with a stable `code`. */
export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: z.string(),
  detail: z.string().optional(),
  errors: z.array(FieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
