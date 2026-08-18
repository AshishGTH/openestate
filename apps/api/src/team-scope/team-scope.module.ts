import { Module } from '@nestjs/common';
import { TeamScopeService } from './team-scope.service';

@Module({
  providers: [TeamScopeService],
  exports: [TeamScopeService],
})
export class TeamScopeModule {}
