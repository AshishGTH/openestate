import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';

@Injectable()
export class RolesService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
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

  async create(
    companyId: string,
    data: { name: string; slug: string; permissionIds: string[] },
  ) {
    const existing = await this.systemPrisma.role.findFirst({
      where: { slug: data.slug, companyId },
    });
    if (existing) {
      throw new BadRequestException('Role slug already exists');
    }

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
  ) {
    const role = await this.findOne(companyId, roleId);
    if (role.isSystem && data.name !== undefined && data.name !== role.name) {
      throw new BadRequestException('Cannot rename system roles');
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
    );
  }

  async remove(companyId: string, roleId: string) {
    const role = await this.findOne(companyId, roleId);
    if (role.isSystem) {
      throw new BadRequestException('Cannot delete system roles');
    }
    if (role._count.users > 0) {
      throw new BadRequestException(
        'Cannot delete role with assigned users',
      );
    }

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
