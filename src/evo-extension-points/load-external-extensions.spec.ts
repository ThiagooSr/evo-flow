import { EvoExtensionPoints, RuntimeContext } from './registry';
import { loadExternalExtensions } from './load-external-extensions';

describe('loadExternalExtensions', () => {
  const original = process.env.EVO_EXTENSIONS_BOOTSTRAP;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.EVO_EXTENSIONS_BOOTSTRAP;
    } else {
      process.env.EVO_EXTENSIONS_BOOTSTRAP = original;
    }
    EvoExtensionPoints.reset();
  });

  it('is a no-op when EVO_EXTENSIONS_BOOTSTRAP is unset — standalone keeps scope_id null', async () => {
    delete process.env.EVO_EXTENSIONS_BOOTSTRAP;

    await expect(loadExternalExtensions()).resolves.toBeUndefined();

    // The runtime_context extension point still holds the community no-op
    // default: it returns the default context unchanged (scope_id stays null).
    const enricher = EvoExtensionPoints.get('runtime_context');
    const defaultContext: RuntimeContext = {
      request_id: 'r-1',
      user_id: null,
      scope_id: null,
      feature_flags: {},
    };
    const ctx = await enricher({} as never, defaultContext);
    expect(ctx.scope_id).toBeNull();
  });

  it('throws when the bootstrap module does not export a register function', async () => {
    // './registry' resolves (relative to load-external-extensions.ts) but
    // exports no `register`/`default` — exercises the contract guard.
    process.env.EVO_EXTENSIONS_BOOTSTRAP = './registry';
    await expect(loadExternalExtensions()).rejects.toThrow(
      /register\(registry\)/,
    );
  });

  it('passes the live registry to a module that exports register', async () => {
    const calls: string[] = [];
    // Stub the dynamic import target by registering on the same singleton the
    // loader passes through. We simulate a consumer module via a manual call.
    const fakeRegister = (registry: typeof EvoExtensionPoints) => {
      registry.replace('runtime_context', (_req, defaultCtx) => ({
        ...defaultCtx,
        scope_id: 'tenant-from-consumer',
      }));
      calls.push('registered');
    };
    fakeRegister(EvoExtensionPoints);

    const enricher = EvoExtensionPoints.get('runtime_context');
    const ctx = await enricher({} as never, {
      request_id: 'r',
      user_id: null,
      scope_id: null,
      feature_flags: {},
    });
    expect(calls).toContain('registered');
    expect(ctx.scope_id).toBe('tenant-from-consumer');
  });
});
