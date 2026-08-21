import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
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
import { InventoryGroupController } from './inventory-group.controller';
import { InventoryGroupService } from './inventory-group.service';

@Module({
  imports: [CustomFieldsModule],
  controllers: [
    ProjectController,
    TowerController,
    // Registered BEFORE UnitController: both mount under
    // projects/:projectId/units, and UnitController's GET ':id' would
    // otherwise swallow GET .../units/export and .../units/import-template
    // as id="export"/"import-template" — Express/Nest match routes in
    // registration order, first pattern wins (the exact bug class
    // CLAUDE.md's v0.3.1 GET /inquiries/import-template entry documents).
    ImportExportController,
    UnitController,
    ProjectMediaController,
    InventoryGroupController,
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
    InventoryGroupService,
  ],
  exports: [
    UnitStateMachineService,
    UploadService,
  ],
})
export class InventoryModule {}
