#!/usr/bin/env node
import { generateKeyPairPem } from '@mc/core';

/** Prints a fresh EdDSA key pair as `.env` lines (PEM newlines escaped as `\n`). */
const { privateKeyPem, publicKeyPem } = await generateKeyPairPem();
const escape = (pem: string) => pem.trim().replace(/\n/g, '\\n');
console.log(`JWT_PRIVATE_KEY="${escape(privateKeyPem)}"`);
console.log(`JWT_PUBLIC_KEY="${escape(publicKeyPem)}"`);
