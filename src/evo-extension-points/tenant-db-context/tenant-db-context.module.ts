import { Global, Module } from '@nestjs/common';
import { TenantDbContext } from './tenant-db-context.service';

/**
 * Provides the {@link TenantDbContext} seam (ADR14, story 10.1b) application-wide.
 * Global so any feature module can inject it without an explicit import — the
 * tenant-scoped services across campaigns/journeys/segments/labels/click-tracking
 * resolve their repositories through it instead of the global pool.
 *
 * Community ships only this no-op seam; the enterprise overlay contributes the
 * per-request transaction interceptor (and replaces the `tenant_db_context`
 * extension point) through the `plugin_loader` seam.
 */
@Global()
@Module({
  providers: [TenantDbContext],
  exports: [TenantDbContext],
})
export class TenantDbContextModule {}
