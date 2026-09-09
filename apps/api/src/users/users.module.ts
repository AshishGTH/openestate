import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { TeamScopeModule } from '../team-scope/team-scope.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TeamScopeModule, AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
