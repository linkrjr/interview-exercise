#!/usr/bin/env bun
import { ApiClient, Store } from '@mc/cli';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from './app.js';
import { acceptInvite, login, logout } from './auth.js';
import { createApis } from './apis.js';
import { loadSession } from './session.js';

const store = Store.fromEnv(process.env);
const client = new ApiClient(store, fetch);

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App
    session={await loadSession(store)}
    apis={createApis(client)}
    onLogin={async (input) => {
      await login(client, store, input);
      return loadSession(store);
    }}
    onAcceptInvite={async (input) => {
      await acceptInvite(client, store, input);
      return loadSession(store);
    }}
    onSignOut={async () => {
      await logout(client, store);
      return loadSession(store);
    }}
  />,
);
