#!/usr/bin/env bun
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from './app.js';
import { loadSession } from './session.js';

const session = await loadSession();
const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App session={session} />);
