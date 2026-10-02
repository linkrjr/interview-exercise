import { z } from 'zod';

export const FieldErrorSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

/**
 * RFC 9457 `application/problem+json` body with a stable `code`. Problems may carry extension
 * members (e.g. the missions that block an unavailability range), so unknown keys are kept.
 */
export const ProblemDetailsSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: z.string(),
  detail: z.string().optional(),
  errors: z.array(FieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
