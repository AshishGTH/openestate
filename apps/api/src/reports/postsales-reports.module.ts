import { Module } from '@nestjs/common';
import { ClockProvider } from '../common/clock.provider';
import { PostsalesModule } from '../postsales/postsales.module';
import { PostsalesReportsController } from './postsales-reports.controller';
import { PostsalesReportsService } from './postsales-reports.service';

@Module({
  imports: [PostsalesModule],
  controllers: [PostsalesReportsController],
  providers: [ClockProvider, PostsalesReportsService],
})
export class PostsalesReportsModule {}
