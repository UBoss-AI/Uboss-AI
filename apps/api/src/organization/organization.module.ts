import { Global, Module } from '@nestjs/common';

import { HIERARCHY_RESOLVER } from '../authorization/authorization.service.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { EmployeePhotoController } from './employee-photo.controller.js';
import { EmployeePhotoService } from './employee-photo.service.js';
import { SettingsModule } from '../settings/settings.module.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { DepartmentService } from './department.service.js';
import { EmploymentService } from './employment.service.js';
import { HierarchyService } from './hierarchy.service.js';
import { OrganizationController } from './organization.controller.js';
import { PersonRegistryService } from './person-registry.service.js';
import { ProfileSearchController } from './profile-search.controller.js';
import { ProfileSearchService } from './profile-search.service.js';
import { ReportingHierarchyResolver } from './reporting-hierarchy.resolver.js';

/**
 * The organization module: departments, reporting relationships, employment records and the
 * global person registry.
 *
 * ## This module is what makes `TeamSubtree` work
 *
 * `HIERARCHY_RESOLVER` has been a declared-but-unprovided injection token since Prompt 7. The
 * `AuthorizationModule` comment says so explicitly: "`HIERARCHY_RESOLVER` is deliberately **not**
 * provided. `TeamSubtree` scope therefore fails closed." Providing it here is the whole of what
 * closes known limitation 6 — and providing it from *this* module rather than from the
 * authorization module is deliberate: authorization must not depend on the org chart's storage,
 * only on the question it can answer.
 *
 * `@Global` for the same reason as the other cross-cutting modules: later prompts (Users &
 * Access, Objectives, Engine Agent assignment) all need to ask about the reporting tree, and
 * importing this module everywhere would be noise.
 */
@Global()
@Module({
  // Declared rather than relying on @Global registration order: ProfileSearchService reads
  // the two portable-search policies through CompanySettingsService, and this module is
  // registered before SettingsModule in AppModule. Prompt 36 hit the same trap in AuditModule.
  // KnowledgeModule for `FileService`: a photo is a file, and Prompt 40A reuses the Prompt 35
  // layer rather than adding a second upload path.
  imports: [SettingsModule, KnowledgeModule],
  // Prompt 37A. Portable profile search belongs here rather than in its own module: it reads
  // the person registry and the employment records this module already owns, and a separate
  // module would have been a second place that knows how a person maps to their employments.
  controllers: [OrganizationController, ProfileSearchController, EmployeePhotoController],
  providers: [
    OrganizationRepository,
    PersonRegistryService,
    DepartmentService,
    HierarchyService,
    EmploymentService,
    ProfileSearchService,
    EmployeePhotoService,
    ReportingHierarchyResolver,
    {
      // The seam the authorization engine has been waiting for. Registered as the token rather
      // than as the class, so `AuthorizationService`'s optional injection finds it without
      // knowing this module exists.
      provide: HIERARCHY_RESOLVER,
      useExisting: ReportingHierarchyResolver,
    },
  ],
  exports: [
    OrganizationRepository,
    PersonRegistryService,
    ProfileSearchService,
    DepartmentService,
    HierarchyService,
    EmploymentService,
    EmployeePhotoService,
    HIERARCHY_RESOLVER,
  ],
})
export class OrganizationModule {}
