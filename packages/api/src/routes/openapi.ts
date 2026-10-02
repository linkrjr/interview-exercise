import { buildOpenApiDocument } from '@mc/contracts';
import type { FastifyInstance } from 'fastify';

/** The OpenAPI 3.1 document, generated from the Zod contracts; public like any API reference. */
export function openApiRoutes(app: FastifyInstance): void {
  const document = buildOpenApiDocument();
  app.get('/v1/openapi.json', async () => document);
}
