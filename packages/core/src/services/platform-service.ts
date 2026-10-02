import {
  AppError,
  ErrorCodes,
  type CreateOrganisationRequest,
  type CreateOrganisationResponse,
  type ReissueInviteResponse,
} from '@mc/contracts';
import { newId, schema, type Db } from '@mc/db';
import type { Clock } from '../clock.js';
import { isForeignKeyViolation, isUniqueViolation, notFound } from '../errors.js';
import { issueInvite } from './invites.js';

export interface PlatformDeps {
  db: Db;
  clock: Clock;
}

/**
 * Operator provisioning. The operator belongs to no organisation and runs through `app_platform`,
 * which can only insert (DESIGN.md §11): it generates ids itself and cannot read anything back.
 */
export class PlatformService {
  constructor(private readonly deps: PlatformDeps) {}

  async createOrganisation(input: CreateOrganisationRequest): Promise<CreateOrganisationResponse> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const organisationId = newId();
    const directorUserId = newId();
    try {
      const invite = await db.withPlatform(async (tx) => {
        await tx
          .insert(schema.organisations)
          .values({ id: organisationId, name: input.name, createdAt: now });
        await tx.insert(schema.users).values({
          id: directorUserId,
          orgId: organisationId,
          email: input.directorEmail,
          role: 'director',
          status: 'invited',
          createdAt: now,
        });
        return issueInvite(tx, organisationId, directorUserId, now);
      });
      return {
        organisationId,
        directorUserId,
        invite: { inviteCode: invite.code, expiresAt: invite.expiresAt.toISOString() },
      };
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) {
        throw new AppError(
          ErrorCodes.EMAIL_ALREADY_REGISTERED,
          409,
          'That email address is already registered',
        );
      }
      throw error;
    }
  }

  /**
   * Issues a new invite for a user of an organisation (e.g. the first Director). The operator
   * cannot read tenant data, so it names the user; the composite foreign key guarantees the user
   * belongs to the organisation, and acceptance only works while the user is still `invited`.
   */
  async reissueInvite(orgId: string, userId: string): Promise<ReissueInviteResponse> {
    const { db, clock } = this.deps;
    const now = clock.now();
    try {
      const invite = await db.withPlatform((tx) => issueInvite(tx, orgId, userId, now));
      return { invite: { inviteCode: invite.code, expiresAt: invite.expiresAt.toISOString() } };
    } catch (error) {
      if (isForeignKeyViolation(error)) throw notFound('User');
      throw error;
    }
  }
}
