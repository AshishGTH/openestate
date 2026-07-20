import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { RolesService } from './roles.service';
import { createRoleSchema, updateRoleSchema } from './roles.dto';

class CreateRoleDto extends createZodDto(createRoleSchema) {}
class UpdateRoleDto extends createZodDto(updateRoleSchema) {}

@ApiTags('Roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_ROLE_READ)
  @ApiOperation({ summary: 'List roles' })
  findAll(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.rolesService.findAll(user.companyId);
  }

  @Get('permissions')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLE_READ)
  @ApiOperation({ summary: 'List all available permissions' })
  getAllPermissions() {
    return this.rolesService.getAllPermissions();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLE_READ)
  @ApiOperation({ summary: 'Get role by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.rolesService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_ROLE_CREATE)
  @ApiOperation({ summary: 'Create role' })
  create(@Body() dto: CreateRoleDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.rolesService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLE_UPDATE)
  @ApiOperation({ summary: 'Update role' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.rolesService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_ROLE_DELETE)
  @ApiOperation({ summary: 'Delete role' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.rolesService.remove(user.companyId, id);
  }
}
