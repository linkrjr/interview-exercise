import { Validator } from '@seriousme/openapi-schema-validator';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, documentedRoutes } from './index.js';
import { operations } from './operations.js';

const doc = buildOpenApiDocument() as {
  openapi: string;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
};

describe('the OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(doc);
    expect(result.errors ?? result.valid).toBeTruthy();
    expect(result.valid).toBe(true);
    expect(doc.openapi).toBe('3.1.0');
  });

  it('resolves every $ref', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(50);
    for (const [, kind, name] of refs) {
      expect(
        (doc.components as Record<string, Record<string, unknown>>)[kind!]![name!],
      ).toBeDefined();
    }
  });

  it('gives every operation a unique id and declares every path parameter', () => {
    const ids = operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [path, methods] of Object.entries(doc.paths)) {
      const wanted = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const operation of Object.values(methods)) {
        const declared = ((operation.parameters as { name: string; in: string }[]) ?? [])
          .filter((p) => p.in === 'path')
          .map((p) => p.name);
        expect(declared).toEqual(wanted);
      }
    }
  });

  it('requires If-Match exactly on the mission changes', () => {
    const withIfMatch = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, op]) =>
          ((op.parameters as { name: string }[]) ?? []).some((p) => p.name === 'If-Match'),
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(withIfMatch.sort()).toEqual([
      'PATCH /v1/missions/{id}',
      'POST /v1/missions/{id}/match/{proposalId}/apply',
      'POST /v1/missions/{id}/transitions',
      'PUT /v1/missions/{id}/crew',
      'PUT /v1/missions/{id}/requirements',
    ]);
  });

  it('keeps the test-only endpoints out', () => {
    expect(Object.keys(doc.paths).filter((p) => p.startsWith('/v1/test'))).toEqual([]);
    expect(JSON.stringify(doc)).not.toMatch(/\/v1\/test|seed/i);
  });

  it('marks the public endpoints as needing no credential', () => {
    const publicRoutes = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, op]) => (op.security as unknown[]).length === 0)
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(publicRoutes.sort()).toEqual([
      'GET /v1/openapi.json',
      'POST /v1/auth/accept-invite',
      'POST /v1/auth/login',
      'POST /v1/auth/logout',
      'POST /v1/auth/refresh',
    ]);
  });

  it('lists its routes for comparison with the server', () => {
    expect(documentedRoutes()).toHaveLength(operations.length);
  });

  it('matches the committed copy (run `pnpm openapi:generate` after changing a contract)', () => {
    const committed = readFileSync(
      fileURLToPath(new URL('../../../../openapi/openapi.json', import.meta.url)),
      'utf8',
    );
    expect(committed).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });
});
