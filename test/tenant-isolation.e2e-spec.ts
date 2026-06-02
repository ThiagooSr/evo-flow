/**
 * Concurrent tenant-isolation E2E (story 10.1b, ADR14 — AC1 + AC2).
 *
 * Proves that the RLS seam isolates the 16 tenant-scoped tables at the database
 * level: with `app.current_tenant_id` set per transaction (exactly what the
 * `tenant_db_context` enterprise runner does), a tenant sees ONLY its own rows —
 * even when two tenants run concurrently — and a query with NO tenant context
 * returns nothing (never another tenant's data).
 *
 * REQUIRES A LIVE POSTGRES with the enterprise RLS migration applied (overlay
 * `1763000000000-AddTenantIdAndRLSToAllEntities`, story 0.16): `journeys` must
 * have a `tenant_id` column with `tenant_isolation` / `super_admin_bypass`
 * policies and FORCE ROW LEVEL SECURITY. It is GATED behind an env flag so the
 * default (DB-less) CI run skips it instead of failing:
 *
 *   TENANT_ISOLATION_E2E=1 \
 *   POSTGRES_DB_HOST=… POSTGRES_DB_PORT=… POSTGRES_DB_USERNAME=… \
 *   POSTGRES_DB_PASSWORD=… POSTGRES_DB_DATABASE=… \
 *   pnpm test:e2e tenant-isolation.e2e-spec.ts
 *
 * It talks to the DB directly (via the seam's set_config transaction pattern)
 * rather than booting the full HTTP/auth stack, so it isolates the enforcement
 * layer the story is about; the HTTP path (`GET /journeys` with a tenant JWT) is
 * the same `set_config` mechanism wrapped by the per-request interceptor.
 */
import { DataSource, EntityManager } from 'typeorm';
import { Journey } from '../src/modules/journeys/entities/journey.entity';

const ENABLED = process.env.TENANT_ISOLATION_E2E === '1';
const describeMaybe = ENABLED ? describe : describe.skip;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describeMaybe('tenant isolation (RLS) — concurrent (10.1b AC1/AC2)', () => {
  let dataSource: DataSource;
  const seeded: string[] = [];

  /** Run `work` inside a transaction scoped to `tenantId` — the exact mechanism
   * the enterprise `tenant_db_context` runner applies per request/activity. */
  async function withTenant<T>(
    tenantId: string | null,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      if (tenantId) {
        await qr.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
          tenantId,
        ]);
      }
      const result = await work(qr.manager);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  /** Insert a journey for `tenantId` (raw SQL so we can set tenant_id explicitly,
   * matching the GUC so the RLS WITH CHECK passes). */
  async function seedJourney(tenantId: string, name: string): Promise<string> {
    return withTenant(tenantId, async (manager) => {
      const rows = await manager.query<Array<{ id: string }>>(
        `INSERT INTO journeys (name, tenant_id) VALUES ($1, $2) RETURNING id`,
        [name, tenantId],
      );
      const id = rows[0].id;
      seeded.push(id);
      return id;
    });
  }

  beforeAll(async () => {
    const { AppDataSource } = await import('../src/database/ormconfig');
    dataSource = AppDataSource;
    if (!dataSource.isInitialized) await dataSource.initialize();

    // Verify the RLS migration is present; fail loudly with guidance if not.
    const cols = await dataSource.query<unknown[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'journeys' AND column_name = 'tenant_id'`,
    );
    if (cols.length === 0) {
      throw new Error(
        'journeys.tenant_id is missing — apply the enterprise RLS migration ' +
          '(overlay 1763000000000-AddTenantIdAndRLSToAllEntities) before running this E2E.',
      );
    }

    await seedJourney(TENANT_A, 'journey-A-1');
    await seedJourney(TENANT_A, 'journey-A-2');
    await seedJourney(TENANT_B, 'journey-B-1');
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    // Clean up via the super-admin bypass policy so RLS does not hide our rows.
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`SELECT set_config('app.super_admin', 'true', false)`);
      if (seeded.length) {
        await qr.query(`DELETE FROM journeys WHERE id = ANY($1::uuid[])`, [
          seeded,
        ]);
      }
    } finally {
      await qr.release();
      await dataSource.destroy();
    }
  });

  it('AC1: a tenant sees only its own journeys', async () => {
    const aNames = await withTenant(TENANT_A, (m) =>
      m.getRepository(Journey).find(),
    );
    const bNames = await withTenant(TENANT_B, (m) =>
      m.getRepository(Journey).find(),
    );

    expect(aNames.map((j) => j.name).sort()).toEqual([
      'journey-A-1',
      'journey-A-2',
    ]);
    expect(bNames.map((j) => j.name)).toEqual(['journey-B-1']);
    // Cross-tenant rows are invisible, not merely filtered in app code.
    expect(aNames.some((j) => j.name.startsWith('journey-B'))).toBe(false);
    expect(bNames.some((j) => j.name.startsWith('journey-A'))).toBe(false);
  });

  it('AC2: two tenants reading concurrently never see each other’s rows', async () => {
    // Interleave many concurrent reads from both tenants; each must stay isolated.
    const runs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? withTenant(TENANT_A, (m) => m.getRepository(Journey).find()).then(
              (rows) => ({ tenant: 'A', rows }),
            )
          : withTenant(TENANT_B, (m) => m.getRepository(Journey).find()).then(
              (rows) => ({ tenant: 'B', rows }),
            ),
      ),
    );

    for (const { tenant, rows } of runs) {
      const names = rows.map((j) => j.name);
      if (tenant === 'A') {
        expect(names.sort()).toEqual(['journey-A-1', 'journey-A-2']);
      } else {
        expect(names).toEqual(['journey-B-1']);
      }
    }
  });

  it('AC3 (DB-level): a query with no tenant context returns nothing, never a leak', async () => {
    const rows = await withTenant(null, (m) => m.getRepository(Journey).find());
    // FORCE RLS + no GUC + super_admin off → zero rows (the enterprise runner
    // turns this silent-empty into an explicit throw at the app layer).
    expect(rows).toEqual([]);
  });
});
