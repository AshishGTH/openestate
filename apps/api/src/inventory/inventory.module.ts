import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { TowerController } from './tower.controller';
import { TowerService } from './tower.service';
import { UnitController } from './unit.controller';
import { UnitService } from './unit.service';
import { UnitStateMachineService } from './unit-state-machine.service';
import { RateRevisionService } from './rate-revision.service';
import { UnitPricingService } from './unit-pricing.service';
import { ImportExportController } from './import-export.controller';
import { ImportExportService } from './import-export.service';
import { UploadService } from './upload.service';
import { ProjectMediaController } from './project-media.controller';
import { ProjectMediaService } from './project-media.service';

@Module({
  controllers: [
    ProjectController,
    TowerController,
    UnitController,
    ImportExportController,
    ProjectMediaController,
  ],
  providers: [
    ProjectService,
    TowerService,
    UnitService,
    UnitStateMachineService,
    RateRevisionService,
    UnitPricingService,
    ImportExportService,
    UploadService,
    ProjectMediaService,
  ],
  exports: [
    UnitStateMachineService,
    UploadService,
  ],
})
export class InventoryModule {}
