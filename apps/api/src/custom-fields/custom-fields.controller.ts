import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createCustomFieldSchema,
  updateCustomFieldSchema,
  purgeCustomFieldSchema,
  CUSTOM_FIELD_ENTITIES,
  PERMISSIONS,
} from '@openestate/shared';
import type { CustomFieldEntity, JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { CustomFieldsService } from './custom-fields.service';

class CreateCustomFieldDto extends createZodDto(createCustomFieldSchema) {}
class UpdateCustomFieldDto extends createZodDto(updateCustomFieldSchema) {}
class PurgeCustomFieldDto extends createZodDto(purgeCustomFieldSchema) {}

@ApiTags('Custom Fields')
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly customFieldsService: CustomFieldsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOM_FIELD_READ)
  @ApiOperation({ summary: 'List custom fields for an entity type' })
  findByEntity(
    @Query('entityType') entityType: string,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    if (!CUSTOM_FIELD_ENTITIES.includes(entityType as CustomFieldEntity)) {
      return [];
    }
    return this.customFieldsService.findByEntity(
      user.companyId,
      entityType as CustomFieldEntity,
    );
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOM_FIELD_READ)
  @ApiOperation({ summary: 'Get custom field by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.customFieldsService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOM_FIELD_CREATE)
  @ApiOperation({ summary: 'Create custom field' })
  create(@Body() dto: CreateCustomFieldDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.customFieldsService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOM_FIELD_UPDATE)
  @ApiOperation({ summary: 'Update custom field' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomFieldDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.customFieldsService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOM_FIELD_DELETE)
  @ApiOperation({
    summary: 'Deactivate a custom field (soft delete — stored values are preserved)',
  })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.customFieldsService.remove(user.companyId, id);
  }

  @Get(':id/value-count')
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOM_FIELD_READ)
  @ApiOperation({ summary: 'How many rows currently store a value for this field' })
  countValues(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.customFieldsService.countValues(user.companyId, id);
  }

  @Post(':id/purge')
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOM_FIELD_DELETE)
  @ApiOperation({
    summary:
      'Permanently delete a custom field AND strip its value from every row. Irreversible; requires the field key typed back as confirmation.',
  })
  purge(
    @Param('id') id: string,
    @Body() dto: PurgeCustomFieldDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.customFieldsService.purge(user.companyId, id, dto.confirmKey, user.sub);
  }
}
