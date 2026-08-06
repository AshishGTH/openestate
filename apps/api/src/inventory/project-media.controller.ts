import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { projectMediaCategorySchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { ProjectMediaService } from './project-media.service';

@ApiTags('Project Media')
@Controller('projects/:projectId/media')
export class ProjectMediaController {
  constructor(private readonly mediaService: ProjectMediaService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.INVENTORY_UPLOAD_CREATE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Layout plan / brochure / photo file, plus a "category" field' })
  @ApiOperation({ summary: 'Upload a layout plan, brochure, or photo for a project' })
  async upload(@Param('projectId') projectId: string, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) throw new BadRequestException('No file uploaded');
    const category = projectMediaCategorySchema.safeParse(req.body?.category);
    if (!category.success) {
      throw new BadRequestException('category must be one of layout_plan, brochure, photo');
    }
    const user = req.user as JwtPayload;
    return this.mediaService.upload(user.companyId, projectId, category.data, file);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.INVENTORY_UPLOAD_READ)
  @ApiOperation({ summary: "List a project's layout plans/brochures/photos" })
  list(@Param('projectId') projectId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.mediaService.list(user.companyId, projectId);
  }

  @Get(':mediaId/download')
  @RequirePermissions(PERMISSIONS.INVENTORY_UPLOAD_READ)
  @ApiOperation({ summary: 'Download a project media file' })
  async download(@Param('mediaId') mediaId: string, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const { buffer, mimeType, originalName } = await this.mediaService.getBytes(user.companyId, mediaId);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${originalName}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Delete(':mediaId')
  @RequirePermissions(PERMISSIONS.INVENTORY_UPLOAD_DELETE)
  @ApiOperation({ summary: 'Delete a project media file' })
  remove(@Param('projectId') projectId: string, @Param('mediaId') mediaId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.mediaService.remove(user.companyId, projectId, mediaId);
  }
}
