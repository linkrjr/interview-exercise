#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildOpenApiDocument } from '../openapi/build.js';

/** `openapi <file>` writes the document; `openapi --check <file>` fails when the file is stale. */
const args = process.argv.slice(2);
const check = args[0] === '--check';
const file = check ? args[1] : args[0];
if (!file) {
  console.error('usage: openapi [--check] <file>');
  process.exit(2);
}

const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
if (check) {
  const committed = await readFile(file, 'utf8').catch(() => '');
  if (committed !== generated) {
    console.error(`${file} is out of date with the Zod contracts. Run: pnpm openapi:generate`);
    process.exit(1);
  }
  console.log(`${file} is up to date`);
} else {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, generated);
  console.log(`wrote ${file}`);
}
