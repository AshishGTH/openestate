import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import type {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
  CustomFieldType,
  CustomFieldEntity,
} from '@openestate/shared';

@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findByEntity(companyId: string, entityType: CustomFieldEntity) {
    return this.systemPrisma.customFieldDefinition.findMany({
      where: { companyId, entityType },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findOne(companyId: string, id: string) {
    const field = await this.systemPrisma.customFieldDefinition.findFirst({
      where: { id, companyId },
    });
    if (!field) throw new NotFoundException('Custom field not found');
    return field;
  }

  async create(companyId: string, dto: CreateCustomFieldDto) {
    const existing = await this.systemPrisma.customFieldDefinition.findFirst({
      where: { companyId, entityType: dto.entityType, key: dto.key },
    });
    if (existing) {
      throw new BadRequestException(
        `Custom field "${dto.key}" already exists for ${dto.entityType}`,
      );
    }

    if (
      (dto.fieldType === 'SELECT' || dto.fieldType === 'MULTI_SELECT') &&
      (!dto.options || dto.options.length === 0)
    ) {
      throw new BadRequestException(
        'SELECT/MULTI_SELECT fields require at least one option',
      );
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.customFieldDefinition.create({
          data: { ...dto, companyId },
        }),
      ),
    );
  }

  async update(companyId: string, id: string, dto: UpdateCustomFieldDto) {
    await this.findOne(companyId, id);

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.customFieldDefinition.update({
          where: { id },
          data: dto,
        }),
      ),
    );
  }

  async remove(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.customFieldDefinition.delete({ where: { id } }),
      ),
    );
  }

  buildValidationSchema(
    definitions: Array<{
      key: string;
      fieldType: string;
      isRequired: boolean;
      options: unknown;
    }>,
  ): z.ZodObject<Record<string, z.ZodTypeAny>> {
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const def of definitions) {
      let schema: z.ZodTypeAny;
      switch (def.fieldType as CustomFieldType) {
        case 'TEXT':
          schema = z.string().max(1000);
          break;
        case 'NUMBER':
          schema = z.number();
          break;
        case 'DATE':
          schema = z.coerce.date();
          break;
        case 'BOOLEAN':
          schema = z.boolean();
          break;
        case 'SELECT': {
          const opts = (def.options as string[]) ?? [];
          schema = z.enum(opts as [string, ...string[]]);
          break;
        }
        case 'MULTI_SELECT': {
          const opts = (def.options as string[]) ?? [];
          schema = z.array(z.enum(opts as [string, ...string[]]));
          break;
        }
        default:
          schema = z.unknown();
      }

      shape[def.key] = def.isRequired ? schema : schema.optional();
    }

    return z.object(shape);
  }

  validateCustomFields(
    definitions: Array<{
      key: string;
      fieldType: string;
      isRequired: boolean;
      options: unknown;
    }>,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = this.buildValidationSchema(definitions);
    return schema.parse(data);
  }
}
