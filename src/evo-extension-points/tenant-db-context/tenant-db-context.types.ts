export { TenantDbContextImpl } from '../registry';

/**
 * CLS (AsyncLocalStorage, `nestjs-cls`) key under which the active tenant-scoped
 * `EntityManager` is published for the current HTTP request. The `TenantDbContext`
 * seam reads it so that repository access lands on the SAME connection that
 * carries the RLS GUC (`app.current_tenant_id`).
 *
 * Community never populates it (no-op → global pool manager, OSS untouched); the
 * enterprise overlay's per-request transaction publishes it (ADR14, story 10.1b).
 * Temporal activities run outside CLS and pass the manager explicitly instead.
 */
export const TENANT_DB_MANAGER_CLS_KEY = 'tenant_db_manager';
