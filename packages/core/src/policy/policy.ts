import type { Actor, Role } from '@mc/contracts';
import { forbidden, notFound } from '../errors.js';

export type UserActor = Extract<Actor, { kind: 'user' }>;

/** `can(actor, action, resource)` rule: which roles may perform the action, optionally narrowed by the resource. */
export interface PolicyRule<R = unknown> {
  roles: readonly Role[];
  /** Narrows an allowed role by a property of the resource, e.g. "own mission only". */
  allow?: (actor: UserActor, resource: R) => boolean;
}

export type PolicyRules = Record<string, PolicyRule<never>>;

export interface Policy {
  can(actor: Actor, action: string, resource?: unknown): boolean;
  /**
   * Throws 403 unless the actor's role is one the action allows at all, ignoring any narrowing by
   * resource. Used before loading a resource, so a role that can never act learns nothing about it.
   */
  requireRole(actor: Actor, action: string): void;
  /** Throws 403 when not allowed, or 404 with `concealAs404` so the resource's existence is not revealed. */
  authorize(actor: Actor, action: string, resource?: unknown, options?: AuthorizeOptions): void;
  actions(): string[];
}

export interface AuthorizeOptions {
  concealAs404?: string;
}

/**
 * Builds the authorisation policy from rule tables (DESIGN.md §6). Each spec contributes its
 * own table; unknown actions and the system actor are denied.
 */
export function createPolicy(...tables: PolicyRules[]): Policy {
  const rules = new Map<string, PolicyRule<unknown>>();
  for (const table of tables) {
    for (const [action, rule] of Object.entries(table)) {
      if (rules.has(action)) throw new Error(`Duplicate policy rule for ${action}`);
      rules.set(action, rule as PolicyRule<unknown>);
    }
  }

  const can: Policy['can'] = (actor, action, resource) => {
    if (actor.kind !== 'user') return false;
    const rule = rules.get(action);
    if (!rule || !rule.roles.includes(actor.role)) return false;
    return rule.allow ? rule.allow(actor, resource) : true;
  };

  const roleAllowed = (actor: Actor, action: string): boolean => {
    if (actor.kind !== 'user') return false;
    return rules.get(action)?.roles.includes(actor.role) ?? false;
  };

  return {
    can,
    requireRole(actor, action) {
      if (!roleAllowed(actor, action)) throw forbidden();
    },
    authorize(actor, action, resource, options) {
      if (can(actor, action, resource)) return;
      throw options?.concealAs404 ? notFound(options.concealAs404) : forbidden();
    },
    actions: () => [...rules.keys()].sort(),
  };
}
