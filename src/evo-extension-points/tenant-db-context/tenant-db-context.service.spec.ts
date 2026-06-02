import { EntityManager } from 'typeorm';
import { ClsService } from 'nestjs-cls';
import { EvoExtensionPoints } from '../registry';
import {
  TenantDbContext,
  runInTenantDbContext,
} from './tenant-db-context.service';
import { TENANT_DB_MANAGER_CLS_KEY } from './tenant-db-context.types';

/**
 * Unit tests with fakes only — no database. They prove the seam's wiring:
 * which manager `getRepository()/getManager()` resolves to, and that
 * `runWithTenant` delegates to the registered `tenant_db_context` impl and
 * publishes the resulting manager in CLS for the duration of the work.
 */
describe('TenantDbContext seam', () => {
  const getRepositoryMock = jest.fn((t: unknown) => ({ __repoFor: t }));
  const globalManager = {
    getRepository: getRepositoryMock,
  } as unknown as EntityManager;

  const dataSource = { manager: globalManager } as never;

  /** Minimal in-memory CLS fake backed by a plain map. */
  function makeCls(active = true): ClsService {
    const store = new Map<string, unknown>();
    return {
      isActive: () => active,
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
    } as unknown as ClsService;
  }

  afterEach(() => {
    EvoExtensionPoints.reset();
    jest.clearAllMocks();
  });

  describe('getManager / getRepository (no active context)', () => {
    it('falls back to the global pool manager when CLS has no tenant manager', () => {
      const cls = makeCls(true);
      const db = new TenantDbContext(dataSource, cls);

      expect(db.getManager()).toBe(globalManager);
      db.getRepository('Journey' as never);
      expect(getRepositoryMock).toHaveBeenCalledWith('Journey');
    });

    it('falls back to the global manager when CLS is inactive', () => {
      const db = new TenantDbContext(dataSource, makeCls(false));
      expect(db.getManager()).toBe(globalManager);
    });
  });

  describe('runWithTenant (community no-op impl)', () => {
    it('runs work on the global manager and resolves getManager() to it inside the scope', async () => {
      const cls = makeCls(true);
      const db = new TenantDbContext(dataSource, cls);

      let insideManager: EntityManager | undefined;
      const result = await db.runWithTenant('tenant-A', () => {
        insideManager = db.getManager();
        return Promise.resolve(42);
      });

      expect(result).toBe(42);
      // No-op impl hands back the global manager; the seam publishes it in CLS.
      expect(insideManager).toBe(globalManager);
      // Restored after the scope ends.
      expect(cls.get(TENANT_DB_MANAGER_CLS_KEY)).toBeUndefined();
    });

    it('publishes the impl-provided manager in CLS and restores the previous one', async () => {
      const cls = makeCls(true);
      const tenantManager = {
        getRepository: jest.fn(() => ({})),
      } as unknown as EntityManager;
      EvoExtensionPoints.replace('tenant_db_context', (_ds, _tenantId, work) =>
        work(tenantManager),
      );
      const db = new TenantDbContext(dataSource, cls);

      let insideManager: EntityManager | undefined;
      await db.runWithTenant('tenant-A', () => {
        insideManager = db.getManager();
        return Promise.resolve();
      });

      expect(insideManager).toBe(tenantManager);
      expect(cls.get(TENANT_DB_MANAGER_CLS_KEY)).toBeUndefined();
    });

    it('restores the manager even when work throws', async () => {
      const cls = makeCls(true);
      const db = new TenantDbContext(dataSource, cls);

      await expect(
        db.runWithTenant('tenant-A', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(cls.get(TENANT_DB_MANAGER_CLS_KEY)).toBeUndefined();
    });

    it('propagates the registered impl rejection (e.g. missing tenant)', async () => {
      EvoExtensionPoints.replace('tenant_db_context', () => {
        throw new Error('TENANT_CONTEXT_REQUIRED');
      });
      const db = new TenantDbContext(dataSource, makeCls(true));

      await expect(
        db.runWithTenant(null, () => Promise.resolve('unreachable')),
      ).rejects.toThrow('TENANT_CONTEXT_REQUIRED');
    });
  });

  describe('runInTenantDbContext (Temporal / no-DI path)', () => {
    it('delegates to the registered impl with the explicit manager', async () => {
      const tenantManager = { tag: 'tenant' } as unknown as EntityManager;
      EvoExtensionPoints.replace('tenant_db_context', (_ds, _tenantId, work) =>
        work(tenantManager),
      );

      const got = await runInTenantDbContext(
        dataSource,
        'tenant-A',
        (manager) => Promise.resolve(manager),
      );
      expect(got).toBe(tenantManager);
    });

    it('community default hands work the global pool manager', async () => {
      const got = await runInTenantDbContext(
        dataSource,
        'tenant-A',
        (manager) => Promise.resolve(manager),
      );
      expect(got).toBe(globalManager);
    });
  });
});
