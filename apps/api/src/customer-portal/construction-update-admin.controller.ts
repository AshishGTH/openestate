import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { createConstructionUpdateSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { ConstructionUpdateService } from './construction-update.service';

class CreateConstructionUpdateDto extends createZodDto(createConstructionUpdateSchema) {}

@ApiTags('Construction Updates (Admin)')
@Controller('admin/construction-updates')
export class ConstructionUpdateAdminController {
  constructor(private readonly updates: ConstructionUpdateService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_CONSTRUCTION_UPDATE_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publish a monthly construction-progress update' })
  create(@Body() dto: CreateConstructionUpdateDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.updates.create(user.companyId, user.sub, dto);
  }

  @Post(':id/media')
  @RequirePermissions(PERMISSIONS.ADMIN_CONSTRUCTION_UPDATE_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Photo for the construction-progress gallery' })
  @ApiOperation({ summary: 'Attach a photo to a construction update' })
  async addMedia(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) throw new BadRequestException('No file uploaded');
    const user = req.user as JwtPayload;
    return this.updates.addMedia(user.companyId, id, file);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_CONSTRUCTION_UPDATE_MANAGE)
  @ApiOperation({ summary: 'List construction updates for a project' })
  listForProject(@Query('projectId') projectId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.updates.listForProject(user.companyId, projectId);
  }
}
