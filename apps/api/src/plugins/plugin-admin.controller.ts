import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { PluginAdminService } from './plugin-admin.service';

@ApiTags('Admin Plugins')
@Controller('admin/plugins')
export class PluginAdminController {
  constructor(private readonly pluginAdmin: PluginAdminService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_PLUGIN_READ)
  @ApiOperation({ summary: 'List every plugin this build ships, with this company\'s installation status' })
  list(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pluginAdmin.list(user.companyId);
  }

  @Get(':pluginId')
  @RequirePermissions(PERMISSIONS.ADMIN_PLUGIN_READ)
  @ApiOperation({ summary: 'Plugin manifest + config-field metadata + this company\'s own (non-secret) config' })
  getDetail(@Param('pluginId') pluginId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pluginAdmin.getDetail(user.companyId, pluginId);
  }

  @Post(':pluginId/install')
  @RequirePermissions(PERMISSIONS.ADMIN_PLUGIN_MANAGE)
  @ApiOperation({ summary: 'Install a plugin for this company (config comes after, via PUT config)' })
  install(@Param('pluginId') pluginId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pluginAdmin.install(user.companyId, pluginId, user.sub);
  }

  @Put(':pluginId/config')
  @RequirePermissions(PERMISSIONS.ADMIN_PLUGIN_MANAGE)
  @ApiOperation({ summary: "Set a plugin's config — validated against its own schema, encrypted at rest, secret fields never returned again" })
  setConfig(@Param('pluginId') pluginId: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pluginAdmin.setConfig(user.companyId, pluginId, body);
  }

  @Post(':pluginId/enable')
  @RequirePermissions(PERMISSIONS.ADMIN_PLUGIN_MANAGE)
  @ApiOperation({ summary: 'Enable an installed plugin — 409s if the plugin is unavailable or version-incompatible' })
  enable(@Param('pluginId') pluginId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pluginAdmin.enable(user.companyId, pluginId);
  }

  @Post(':pluginId/disable')
  @RequirePermissions(PERMISSIONS.ADMIN_PLUGIN_MANAGE)
  @ApiOperation({ summary: 'Disable an installed plugin (config is kept)' })
  disable(@Param('pluginId') pluginId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pluginAdmin.disable(user.companyId, pluginId);
  }

  @Delete(':pluginId')
  @RequirePermissions(PERMISSIONS.ADMIN_PLUGIN_MANAGE)
  @ApiOperation({ summary: 'Uninstall a plugin (removes its config)' })
  uninstall(@Param('pluginId') pluginId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pluginAdmin.uninstall(user.companyId, pluginId);
  }
}
