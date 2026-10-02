import { z } from 'zod';
import { componentSchemas, operations, type ComponentName, type Operation } from './operations.js';

export const OPENAPI_VERSION = '3.1.0';
export const API_VERSION = '1.0.0';

type Json = Record<string, unknown>;

/** The shared error responses, by status: component name and description. */
const ERROR_RESPONSES: Record<number, [string, string]> = {
  400: [
    'BadRequest',
    'The request is malformed or fails validation; `errors` lists the offending fields.',
  ],
  401: ['Unauthorized', 'The credential is missing, invalid or expired.'],
  403: ['Forbidden', 'The signed-in user’s role can never do this.'],
  404: ['NotFound', 'The resource does not exist, or is not visible to the caller.'],
  409: ['Conflict', 'The request conflicts with the current state; `code` says how.'],
  412: [
    'PreconditionFailed',
    'The `If-Match` version is stale: someone else changed the mission first.',
  ],
  413: ['PayloadTooLarge', 'The request body is larger than the server accepts.'],
  415: ['UnsupportedMediaType', 'The request body is not `application/json`.'],
  428: ['PreconditionRequired', 'The `If-Match` header is required.'],
  429: ['TooManyRequests', 'Too many requests; wait `Retry-After` seconds.'],
  500: ['InternalError', 'An unexpected error.'],
};

const PROBLEM_CONTENT = {
  'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
};

/** Zod spells `format: uuid|date|…` out as a long regex too; the format says it all. */
const FORMATS_WITHOUT_PATTERN = new Set(['uuid', 'date', 'date-time', 'email', 'uri']);

function dropRedundantPatterns(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(dropRedundantPatterns);
  if (!node || typeof node !== 'object') return;
  const object = node as Json;
  if (typeof object.format === 'string' && FORMATS_WITHOUT_PATTERN.has(object.format)) {
    delete object.pattern;
  }
  Object.values(object).forEach(dropRedundantPatterns);
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const converted = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as Json;
  delete converted.$schema;
  dropRedundantPatterns(converted);
  return converted;
}

const ref = (name: ComponentName) => ({ $ref: `#/components/schemas/${name}` });
const isRequest = (name: string) => name.endsWith('Request');

/** Query schemas become one parameter per property. */
function queryParameters(schema: z.ZodObject): Json[] {
  const converted = jsonSchema(schema, 'input');
  const required = new Set((converted.required as string[] | undefined) ?? []);
  return Object.entries((converted.properties as Record<string, Json>) ?? {}).map(
    ([name, property]) => ({
      name,
      in: 'query',
      required: required.has(name),
      schema: property,
    }),
  );
}

function pathParameters(path: string): Json[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }));
}

function buildOperation(op: Operation): Json {
  const parameters: Json[] = [...pathParameters(op.path)];
  if (op.query) parameters.push(...queryParameters(op.query));
  if (op.ifMatch) {
    parameters.push({
      name: 'If-Match',
      in: 'header',
      required: true,
      description: 'The mission `version` you last saw (also sent as the `ETag`), e.g. `"3"`.',
      schema: { type: 'string' },
    });
  }

  const responses: Record<string, Json> = {};
  const success: Json = { description: op.success.description };
  if (op.success.schema) {
    success.content = { 'application/json': { schema: ref(op.success.schema) } };
  } else if (op.success.status === 200) {
    success.content = { 'application/json': { schema: { type: 'object' } } };
  }
  if (op.success.etag) {
    success.headers = {
      ETag: {
        description: 'The mission version, quoted. Staff views only.',
        schema: { type: 'string' },
      },
    };
  }
  responses[String(op.success.status)] = success;

  const errors = new Set<number>([500, ...(op.errors ?? [])]);
  if (op.auth !== 'public') errors.add(401);
  if (op.body || op.query || op.ifMatch) errors.add(400);
  if (op.body) {
    errors.add(413);
    errors.add(415);
  }
  for (const status of [...errors].sort((a, b) => a - b)) {
    const shared = ERROR_RESPONSES[status];
    if (!shared) throw new Error(`No shared response for status ${status}`);
    responses[String(status)] = { $ref: `#/components/responses/${shared[0]}` };
  }

  return {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(op.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(op.body) } },
          },
        }
      : {}),
    responses,
    security:
      op.auth === 'public'
        ? []
        : [{ [op.auth === 'operator' ? 'operatorToken' : 'userToken']: [] }],
  };
}

/**
 * The OpenAPI 3.1 document for the public API, generated from the Zod contracts. The same function
 * serves `/v1/openapi.json` and writes the committed copy that CI compares against. The test-only
 * endpoints are not part of it (DESIGN.md §16).
 */
export function buildOpenApiDocument(): Json {
  const schemas: Record<string, Json> = {};
  for (const [name, schema] of Object.entries(componentSchemas)) {
    schemas[name] = jsonSchema(schema, isRequest(name) ? 'input' : 'output');
  }

  const paths: Record<string, Record<string, Json>> = {};
  for (const op of operations) {
    (paths[op.path] ??= {})[op.method] = buildOperation(op);
  }

  const tags = [...new Set(operations.map((op) => op.tag))].map((name) => ({ name }));
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Mission Control API',
      version: API_VERSION,
      description:
        'Multi-tenant crew planning for space missions. Errors are `application/problem+json` with a stable `code`. ' +
        'Every mission change needs the version last seen in `If-Match`.',
    },
    servers: [{ url: '/' }],
    tags,
    paths,
    components: {
      securitySchemes: {
        userToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'The access token from `/v1/auth/login`.',
        },
        operatorToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'The static operator credential; accepted on `/v1/platform/*` only.',
        },
      },
      responses: Object.fromEntries(
        Object.values(ERROR_RESPONSES).map(([name, description]) => [
          name,
          {
            description,
            content: PROBLEM_CONTENT,
            ...(name === 'TooManyRequests'
              ? {
                  headers: {
                    'Retry-After': { description: 'Seconds to wait.', schema: { type: 'integer' } },
                  },
                }
              : {}),
          },
        ]),
      ),
      schemas,
    },
  };
}

/** `METHOD /path/{param}` for every operation in the document, for comparing with the real routes. */
export function documentedRoutes(): string[] {
  return operations.map((op) => `${op.method.toUpperCase()} ${op.path}`).sort();
}
