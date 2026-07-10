import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm';
import { EvoExtensionPoints } from '../registry';
import { TENANT_DB_MANAGER_CLS_KEY } from './tenant-db-context.types';

/**
 * The DB-context seam (ADR14, story 10.1b). Tenant-scoped services resolve their
 * `Repository`/`EntityManager` through this provider instead of the global pool
 * (`@InjectRepository` / `DataSource.manager`), so that every query runs on the
 * connection that carries the tenant's RLS context.
 *
 * - **Community / single-tenant standalone:** no overlay is registered, no
 *   transaction is opened, and `getManager()` falls back to the global pool
 *   manager — behaviorally identical to direct `@InjectRepository` usage.
 * - **Enterprise multi-tenant:** the overlay replaces the `tenant_db_context`
 *   extension point with a per-request transaction that applies
 *   `set_config('app.current_tenant_id', …)`, and publishes that transactional
 *   `EntityManager` in CLS via {@link runWithTenant}. Repository access then
 *   lands on the same connection and Postgres RLS filters the rows.
 *
 * The provider is a singleton: it reads the active manager from CLS on every call
 * (AsyncLocalStorage), so there is no request-scope instantiation cost.
 */
@Injectable()
export class TenantDbContext {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cls: ClsService,
  ) {}

  /**
   * The `EntityManager` bound to the active tenant context, or the global pool
   * manager when none is active (community / outside a `runWithTenant` scope).
   */
  getManager(): EntityManager {
    const active = this.cls.isActive()
      ? this.cls.get<EntityManager | undefined>(TENANT_DB_MANAGER_CLS_KEY)
      : undefined;
    return active ?? this.dataSource.manager;
  }

  /** Tenant-scoped repository for `target`. Drop-in for `@InjectRepository`. */
  getRepository<Entity extends ObjectLiteral>(
    target: EntityTarget<Entity>,
  ): Repository<Entity> {
    return this.getManager().getRepository(target);
  }

  /**
   * Run `work` inside the tenant's DB context. Resolves the `tenant_db_context`
   * impl from the registry (no-op passthrough in community; per-request
   * transaction + `set_config` in the enterprise overlay) and publishes the
   * resulting `EntityManager` in CLS for the duration of `work`, so nested
   * `getManager()`/`getRepository()` calls hit the same connection.
   *
   * Convenience wrapper for callers that have a NestJS/CLS context and want to
   * scope a block of `work` themselves. NOTE: the HTTP request path does NOT go
   * through here — the enterprise `TenantTransactionInterceptor` runs the same
   * runner directly and publishes the manager into CLS, so this method is
   * currently unused at runtime (kept as part of the seam's public surface). The
   * enterprise impl is responsible for rejecting a missing tenant when
   * multi-tenant is enabled (AC3 — fail explicitly, never leak).
   */
  async runWithTenant<T>(
    tenantId: string | null,
    work: () => Promise<T>,
  ): Promise<T> {
    const impl = EvoExtensionPoints.get('tenant_db_context');
    return impl(this.dataSource, tenantId, (manager) =>
      this.withManager(manager, work),
    );
  }

  private async withManager<T>(
    manager: EntityManager,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!this.cls.isActive()) {
      // No CLS context (e.g. invoked outside a request). The manager cannot be
      // published for downstream `getManager()` reads; callers in this path must
      // use the manager handed to them directly (Temporal activities do).
      return work();
    }
    const previous = this.cls.get<EntityManager | undefined>(
      TENANT_DB_MANAGER_CLS_KEY,
    );
    this.cls.set(TENANT_DB_MANAGER_CLS_KEY, manager);
    try {
      return await work();
    } finally {
      this.cls.set(TENANT_DB_MANAGER_CLS_KEY, previous);
    }
  }
}

/**
 * Standalone runner for contexts with no NestJS DI / CLS — notably **Temporal
 * activities**, which execute outside the request lifecycle. Threads the
 * `tenantId` (read from the workflow/activity payload) through the same
 * `tenant_db_context` extension point and hands the scoped `EntityManager` to
 * `work` explicitly. Community = no-op passthrough to the global pool manager.
 */
export function runInTenantDbContext<T>(
  dataSource: DataSource,
  tenantId: string | null,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const impl = EvoExtensionPoints.get('tenant_db_context');
  return impl(dataSource, tenantId, work);
}
