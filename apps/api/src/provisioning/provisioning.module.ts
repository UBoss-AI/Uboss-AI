import { Module } from '@nestjs/common';

import { CompanyProvisioningService } from './company-provisioning.service.js';
import { CompanySetupService } from './company-setup.service.js';
import { CompanySetupController, ProvisioningController } from './provisioning.controller.js';
import { TenantProvisioningService } from './tenant-provisioning.service.js';

/**
 * Company provisioning and first-login setup.
 *
 * Two controllers with deliberately different tenancy. `ProvisioningController` is
 * `@PlatformOnly` and holds the only path a company can come into existence by — there is no
 * public signup, and no other route in the product inserts a `tenants` row.
 * `CompanySetupController` is `@TenantScoped`, because the setup checklist belongs to the new
 * company's own administrator rather than to the platform.
 *
 * `TenantProvisioningService` remains for the seed and for `addMember`: it is the narrow
 * "create a tenant and its first membership" primitive that `CompanyProvisioningService` does
 * **not** call, because the wizard needs everything in one transaction of its own and layering
 * one transaction-opening service inside another would fight the ambient-transaction rule.
 */
@Module({
  controllers: [ProvisioningController, CompanySetupController],
  providers: [TenantProvisioningService, CompanyProvisioningService, CompanySetupService],
  exports: [TenantProvisioningService, CompanyProvisioningService, CompanySetupService],
})
export class ProvisioningModule {}
