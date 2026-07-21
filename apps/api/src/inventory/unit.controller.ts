import {
  Body,
  Controller,
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
  createUnitSchema,
  updateUnitSchema,
  bulkGenerateUnitsSchema,
  unitStatusTransitionSchema,
  changeRateSchema,
  paginationQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { UnitService } from './unit.service';
import { UnitStateMachineService } from './unit-state-machine.service';
import { RateRevisionService } from './rate-revision.service';

class CreateUnitDto extends createZodDto(createUnitSchema) {}
class UpdateUnitDto extends createZodDto(updateUnitSchema) {}
class BulkGenerateUnitsDto extends createZodDto(bulkGenerateUnitsSchema) {}
class UnitStatusTransitionDto extends createZodDto(unitStatusTransitionSchema) {}
class ChangeRateDto extends createZodDto(changeRateSchema) {}
class PaginationQueryDto extends createZodDto(paginationQuerySchema) {}

@ApiTags('Units')
@Controller('projects/:projectId/units')
export class UnitController {
  constructor(
    private readonly unitService: UnitService,
    private readonly stateMachine: UnitStateMachineService,
    private readonly rateService: RateRevisionService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_READ)
  @ApiOperation({ summary: 'List units in a project' })
  findAll(
    @Param('projectId') projectId: string,
    @Query() query: PaginationQueryDto,
    @Query('towerId') towerId: string | undefined,
    @Query('floorId') floorId: string | undefined,
    @Query('status') status: string | undefined,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.findAll(user.companyId, projectId, { ...query, towerId, floorId, status });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_READ)
  @ApiOperation({ summary: 'Get unit by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.unitService.findOne(user.companyId, id);
  }

  @Post('floors/:floorId')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_CREATE)
  @ApiOperation({ summary: 'Create unit on a floor' })
  create(
    @Param('floorId') floorId: string,
    @Body() dto: CreateUnitDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.create(user.companyId, floorId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_UPDATE)
  @ApiOperation({ summary: 'Update unit' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUnitDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.update(user.companyId, id, dto);
  }

  @Post('bulk-generate')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_BULK_GENERATE)
  @ApiOperation({ summary: 'Bulk generate units for a tower' })
  bulkGenerate(
    @Param('projectId') projectId: string,
    @Body() dto: BulkGenerateUnitsDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.bulkGenerate(user.companyId, projectId, dto);
  }

  @Post(':id/transition')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_READ)
  @ApiOperation({ summary: 'Transition unit status' })
  transition(
    @Param('id') id: string,
    @Body() dto: UnitStatusTransitionDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.stateMachine.transition(
      user.companyId,
      id,
      dto.toStatus,
      'user',
      user.sub,
      dto.reason,
    );
  }

  @Post('change-rate')
  @RequirePermissions(PERMISSIONS.INVENTORY_RATE_CHANGE)
  @ApiOperation({ summary: 'Change rate for multiple units' })
  changeRate(
    @Param('projectId') projectId: string,
    @Body() dto: ChangeRateDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.rateService.changeRate(user.companyId, projectId, dto, user.sub);
  }

  @Get(':id/rate-history')
  @RequirePermissions(PERMISSIONS.INVENTORY_RATE_READ)
  @ApiOperation({ summary: 'Get rate revision history for a unit' })
  rateHistory(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.rateService.getRateHistory(user.companyId, id, query);
  }
}
