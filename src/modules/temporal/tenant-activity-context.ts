import type { EntityManager } from 'typeorm';
import { runInTenantDbContext } from '../../evo-extension-points';

/**
 * Tenant-DB seam for **Temporal activities** (ADR14, story 10.1b).
 *
 * Activities run outside the HTTP request lifecycle, so there is no
 * `runtime_context` / CLS to read the tenant from — it must travel in the
 * workflow/activity payload. An activity that touches any of the 16 tenant-scoped
 * tables wraps its DB work in this helper, passing `tenantId` from its input, and
 * uses the handed `EntityManager` (NOT `AppDataSource.getRepository(...)`):
 *
 * ```ts
 * await runActivityInTenantDbContext(input.tenantId, (manager) =>
 *   manager.getRepository(CampaignExecution).update(where, updates),
 * );
 * ```
 *
 * Behaviour (delegated to the registered `tenant_db_context` impl, which the
 * enterprise overlay replaces in the worker process via `EVO_EXTENSIONS_BOOTSTRAP`):
 *  - **community / single-tenant:** no-op passthrough / `DEFAULT_TENANT_ID` — runs
 *    on the global pool, no behavior change;
 *  - **enterprise multi-tenant, tenant present:** opens a transaction that applies
 *    `set_config('app.current_tenant_id', …)` so RLS scopes the activity's queries;
 *  - **enterprise multi-tenant, tenant MISSING:** throws `TenantContextMissingError`
 *    — the activity fails explicitly instead of running unscoped (AC3: never leak).
 *
 * `AppDataSource` is imported lazily so this module stays usable inside the
 * Temporal sandbox/worker, mirroring the existing activity DB-access pattern.
 */
export async function runActivityInTenantDbContext<T>(
  tenantId: string | null | undefined,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const { AppDataSource } = await import('../../database/ormconfig');
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
  return runInTenantDbContext(AppDataSource, tenantId ?? null, work);
}
