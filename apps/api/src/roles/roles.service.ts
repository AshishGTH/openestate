import { AuthzVersionService } from '../auth/authz-version.service';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant, getCurrentIpAddress } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import {
  loadCurrentCaller,
  assertCallerActive,
  assertPermissionSubset,
  assertActorIsSuperAdminIfTargetIs,
  isSuperAdminRole,
} from '../common/permission-subset.util';

const SUPER_ADMIN_SLUG = 'super_admin';

@Injectable()
export class RolesService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly authzVersions: AuthzVersionService,
  ) {}

  async findAll(companyId: string) {
    return this.systemPrisma.role.findMany({
      where: { companyId },
      orderBy: { name: 'asc' },
      include: {
        permissions: {
          include: { permission: { select: { key: true } } },
        },
        _count: { select: { users: true } },
      },
    });
  }

  async findOne(companyId: string, roleId: string) {
    const role = await this.systemPrisma.role.findFirst({
      where: { id: roleId, companyId },
      include: {
        permissions: {
          include: { permission: true },
        },
        _count: { select: { users: true } },
      },
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  /** Resolves permission ids to their fully-expanded keys, for subset checks. */
  private async loadPermissionKeys(permissionIds: string[]): Promise<string[]> {
    if (permissionIds.length === 0) return [];
    const perms = await this.systemPrisma.permission.findMany({
      where: { id: { in: permissionIds } },
      select: { key: true },
    });
    return perms.map((p) => p.key);
  }

  async create(
    companyId: string,
    data: { name: string; slug: string; permissionIds: string[] },
    callerId: string,
  ) {
    const caller = await loadCurrentCaller(this.systemPrisma, callerId);
    assertCallerActive(caller);

    // 'super_admin' is the seeded system role, identified by isSystem + this
    // slug. Reserved so no API caller can mint a role that borrows its
    // identity (a company that somehow lacks the seeded row could otherwise).
    if (data.slug === SUPER_ADMIN_SLUG) {
      throw new BadRequestException(`The slug '${SUPER_ADMIN_SLUG}' is reserved.`);
    }
    const existing = await this.systemPrisma.role.findFirst({
      where: { slug: data.slug, companyId },
    });
    if (existing) {
      throw new BadRequestException('Role slug already exists');
    }

    // v0.8.2: you cannot grant a role a permission you don't hold yourself
    // — a new role's permissionIds are what's being GRANTED here.
    const grantedKeys = await this.loadPermissionKeys(data.permissionIds);
    assertPermissionSubset(
      caller.permissionKeys,
      grantedKeys,
      'You cannot create a role with permissions you do not have.',
    );

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const role = await tx.role.create({
          data: {
            companyId,
            name: data.name,
            slug: data.slug,
            isSystem: false,
          },
        });

        if (data.permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: data.permissionIds.map((permissionId) => ({
              roleId: role.id,
              permissionId,
            })),
          });
        }

        return tx.role.findUniqueOrThrow({
          where: { id: role.id },
          include: {
            permissions: {
              include: { permission: { select: { key: true } } },
            },
          },
        });
      }),
    );
  }

  async update(
    companyId: string,
    roleId: string,
    data: { name?: string; permissionIds?: string[] },
    callerId: string,
  ) {
    const caller = await loadCurrentCaller(this.systemPrisma, callerId);
    assertCallerActive(caller);

    const role = await this.findOne(companyId, roleId);
    if (role.isSystem && data.name !== undefined && data.name !== role.name) {
      throw new BadRequestException('Cannot rename system roles');
    }
    // super_admin is defined as "every permission"; sync-permissions keeps it
    // complete. Its permission set is not editable by anyone, super_admin included.
    if (isSuperAdminRole(role) && data.permissionIds !== undefined) {
      throw new BadRequestException(
        `The ${SUPER_ADMIN_SLUG} role's permissions cannot be edited; it always holds every permission.`,
      );
    }
    // Only an existing role can be a portal role: create() never sets
    // isPortal, so this is the one path that can add grants to one.
    if (role.isPortal && data.permissionIds?.length) {
      const perms = await this.systemPrisma.permission.findMany({
        where: { id: { in: data.permissionIds } },
        select: { key: true },
      });
      const notAllowed = perms.map((p) => p.key).filter((k) => !k.startsWith('portal.')).sort();
      if (notAllowed.length > 0) {
        throw new BadRequestException(
          `Portal roles can only hold portal permissions. Not allowed: ${notAllowed.join(', ')}`,
        );
      }
    }

    // v0.8.2: you cannot edit a role that holds permissions you don't have
    // yourself — applies even when the caller is editing THEIR OWN role,
    // deliberately: the check is on the role's current permission set, not
    // on who the caller is, so it can't be sidestepped by self-editing.
    const currentKeys = role.permissions.map((rp) => rp.permission.key);
    assertActorIsSuperAdminIfTargetIs(caller, role);
    assertPermissionSubset(
      caller.permissionKeys,
      currentKeys,
      'You cannot edit a role that holds permissions you do not have.',
    );
    if (data.permissionIds) {
      // ...and you cannot grant it any permission you don't have either.
      const grantedKeys = await this.loadPermissionKeys(data.permissionIds);
      assertPermissionSubset(
        caller.permissionKeys,
        grantedKeys,
        'You cannot grant a role permissions you do not have.',
      );
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        if (data.name) {
          await tx.role.update({
            where: { id: roleId },
            data: { name: data.name },
          });
        }

        if (data.permissionIds) {
          await tx.rolePermission.deleteMany({ where: { roleId } });
          if (data.permissionIds.length > 0) {
            await tx.rolePermission.createMany({
              data: data.permissionIds.map((permissionId) => ({
                roleId,
                permissionId,
              })),
            });
          }
          // v0.8.2 Part D: rolePermission.deleteMany/createMany are *Many
          // operations, which AUDITED_MODELS's generic Prisma extension
          // hook never fires for (create/update/delete only) — so a role's
          // permission set changing left no audit row at all. Written
          // explicitly, same pattern as UsersService's RESET_LINK_ISSUED.
          await tx.auditLog.create({
            data: {
              companyId,
              userId: callerId,
              entityType: 'Role',
              entityId: roleId,
              action: 'ROLE_PERMS_CHANGED',
              after: { permissionIds: data.permissionIds },
              ipAddress: getCurrentIpAddress(),
            },
          });
        }

        return tx.role.findUniqueOrThrow({
          where: { id: roleId },
          include: {
            permissions: {
              include: { permission: { select: { key: true } } },
            },
          },
        });
      }),
    ).then(async (updated) => {
      // Editing a role's permissions ends the sessions of everyone holding it:
      // their tokens carry the old permission list. Their browsers refresh into
      // tokens with the new list. Other roles are untouched.
      if (data.permissionIds) await this.authzVersions.bumpRole(roleId);
      return updated;
    });
  }

  async remove(companyId: string, roleId: string, callerId: string) {
    const caller = await loadCurrentCaller(this.systemPrisma, callerId);
    assertCallerActive(caller);

    const role = await this.findOne(companyId, roleId);
    if (role.isSystem) {
      throw new BadRequestException('Cannot delete system roles');
    }
    if (role._count.users > 0) {
      throw new BadRequestException(
        'Cannot delete role with assigned users',
      );
    }

    // v0.8.2: same subset gate as create/update — for consistency, though
    // a role held together by permissions the caller lacks would already
    // be blocked from reaching 0 users under the same gate in update()/
    // UsersService in the first place.
    const currentKeys = role.permissions.map((rp) => rp.permission.key);
    assertActorIsSuperAdminIfTargetIs(caller, role);
    assertPermissionSubset(
      caller.permissionKeys,
      currentKeys,
      'You cannot delete a role that holds permissions you do not have.',
    );

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        return tx.role.delete({ where: { id: roleId } });
      }),
    );
  }

  async getAllPermissions() {
    return this.systemPrisma.permission.findMany({
      orderBy: { key: 'asc' },
    });
  }
}
