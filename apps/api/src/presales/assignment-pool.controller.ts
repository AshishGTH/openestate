import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { upsertAssignmentPoolSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { AssignmentService } from './assignment.service';

class UpsertAssignmentPoolDto extends createZodDto(upsertAssignmentPoolSchema) {}

@ApiTags('Assignment Pool')
@Controller('projects/:projectId/assignment-pool')
export class AssignmentPoolController {
  constructor(private readonly assignmentService: AssignmentService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_ASSIGNMENT_POOL_MANAGE)
  @ApiOperation({ summary: 'List round-robin pool membership for a project' })
  list(@Param('projectId') projectId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.assignmentService.listPool(user.companyId, projectId);
  }

  @Put(':userId')
  @RequirePermissions(PERMISSIONS.PRESALES_ASSIGNMENT_POOL_MANAGE)
  @ApiOperation({ summary: 'Add/update/pause a user in the round-robin pool' })
  upsert(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() dto: UpsertAssignmentPoolDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.assignmentService.setMembership(user.companyId, projectId, userId, dto);
  }
}
