import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  createUserSchema,
  updateUserSchema,
  paginationQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { UsersService } from './users.service';
import { TeamScopeService } from '../team-scope/team-scope.service';

class CreateUserDto extends createZodDto(createUserSchema) {}
class UpdateUserDto extends createZodDto(updateUserSchema) {}
class PaginationQueryDto extends createZodDto(paginationQuerySchema) {}

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly teamScope: TeamScopeService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_USER_READ)
  @ApiOperation({ summary: 'List users' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.findAll(user.companyId, query);
  }

  /**
   * MUST stay declared ABOVE `@Get(':id')`. Nest registers a controller's
   * routes with Express in method-declaration order and Express matches
   * the first pattern that fits, so with the order reversed a request for
   * the literal path `/users/hierarchy` is swallowed as `id="hierarchy"`
   * and 404s. This is the exact hazard that bit `/inquiries/import-template`
   * (see CLAUDE.md v0.3.1) — the ordering here is load-bearing, not
   * cosmetic.
   */
  @Get('hierarchy')
  @RequirePermissions(PERMISSIONS.ADMIN_USER_READ)
  @ApiOperation({
    summary: "Read-only org tree, scoped to the caller's visible subtree (admins see the whole company)",
  })
  async hierarchy(@Req() req: Request) {
    const user = req.user as JwtPayload;
    const visibleUserIds = await this.teamScope.getVisibleUserIds(
      user.companyId,
      user.sub,
      user.permissions,
    );
    return this.usersService.getHierarchy(user.companyId, visibleUserIds);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_USER_READ)
  @ApiOperation({ summary: 'Get user by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_USER_CREATE)
  @ApiOperation({ summary: 'Create user' })
  create(@Body() dto: CreateUserDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_USER_UPDATE)
  @ApiOperation({ summary: 'Update user' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.usersService.update(user.companyId, id, dto);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ADMIN_USER_DEACTIVATE)
  @ApiOperation({ summary: 'Deactivate user (soft delete)' })
  deactivate(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.deactivate(user.companyId, id);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ADMIN_USER_UPDATE)
  @ApiOperation({ summary: 'Reactivate user' })
  reactivate(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.reactivate(user.companyId, id);
  }

  @Post(':id/force-password-reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.ADMIN_USER_UPDATE)
  @ApiOperation({ summary: "Force a password reset for another user (issues a reset link, never sets one directly)" })
  forcePasswordReset(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.forcePasswordReset(user.companyId, id, user.sub);
  }
}
