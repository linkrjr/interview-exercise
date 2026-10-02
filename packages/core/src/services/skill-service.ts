import type {
  Actor,
  CreateSkillRequest,
  ListSkillsQuery,
  Page,
  Skill,
  UpdateSkillRequest,
} from '@mc/contracts';
import { AppError, ErrorCodes } from '@mc/contracts';
import { newId, schema, type Db } from '@mc/db';
import { asc, eq, gt } from 'drizzle-orm';
import type { AuditWriter } from '../audit.js';
import type { Clock } from '../clock.js';
import { isUniqueViolation, notFound } from '../errors.js';
import { decodeCursor, toPage } from '../pagination.js';
import type { Policy } from '../policy/index.js';
import { userOrg } from './org-settings-service.js';

type SkillRow = typeof schema.skills.$inferSelect;

export const toSkill = (row: SkillRow): Skill => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
});

const nameTaken = () =>
  new AppError(ErrorCodes.SKILL_NAME_TAKEN, 409, 'A skill with that name already exists');

export interface SkillServiceDeps {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  policy: Policy;
}

/**
 * The organisation's skill catalogue (DESIGN.md OQ-7, OQ-11). Skills can be added and renamed;
 * they can be neither archived nor deleted.
 */
export class SkillService {
  constructor(private readonly deps: SkillServiceDeps) {}

  async list(actor: Actor, query: ListSkillsQuery): Promise<Page<Skill>> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'skill.list');
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    return db.withTenant(userOrg(actor), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.skills)
        .where(after ? gt(schema.skills.id, after) : undefined)
        .orderBy(asc(schema.skills.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toSkill);
    });
  }

  async create(actor: Actor, input: CreateSkillRequest): Promise<Skill> {
    const { db, audit, clock, policy } = this.deps;
    policy.authorize(actor, 'skill.create');
    const orgId = userOrg(actor);
    try {
      return await db.withTenant(orgId, async (tx) => {
        const [skill] = await tx
          .insert(schema.skills)
          .values({ id: newId(), orgId, name: input.name, createdAt: clock.now() })
          .returning();
        await audit.record(tx, {
          action: 'skill.created',
          entityType: 'skill',
          entityId: skill!.id,
          after: { name: skill!.name },
          actorId: actorId(actor),
        });
        return toSkill(skill!);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'skills_org_id_name_key')) throw nameTaken();
      throw error;
    }
  }

  async rename(actor: Actor, skillId: string, input: UpdateSkillRequest): Promise<Skill> {
    const { db, audit, policy } = this.deps;
    policy.authorize(actor, 'skill.rename');
    try {
      return await db.withTenant(userOrg(actor), async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.skills)
          .where(eq(schema.skills.id, skillId))
          .limit(1)
          .for('update');
        if (!current) throw notFound('Skill');
        if (current.name === input.name) return toSkill(current);

        const [renamed] = await tx
          .update(schema.skills)
          .set({ name: input.name })
          .where(eq(schema.skills.id, skillId))
          .returning();
        await audit.record(tx, {
          action: 'skill.renamed',
          entityType: 'skill',
          entityId: skillId,
          before: { name: current.name },
          after: { name: renamed!.name },
          actorId: actorId(actor),
        });
        return toSkill(renamed!);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'skills_org_id_name_key')) throw nameTaken();
      throw error;
    }
  }
}

export const actorId = (actor: Actor): string | null =>
  actor.kind === 'user' ? actor.userId : null;
