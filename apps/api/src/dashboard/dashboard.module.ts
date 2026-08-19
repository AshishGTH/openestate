import { Module } from '@nestjs/common';
import { PresalesModule } from '../presales/presales.module';
import { TeamScopeModule } from '../team-scope/team-scope.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  // PresalesModule for ReportsService (funnelByStatus is reused here rather
  // than reimplemented) and for the CLOCK provider it already exports.
  imports: [PresalesModule, TeamScopeModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
