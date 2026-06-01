import { EvoExtensionPoints } from './registry';

/**
 * Generic, env-gated bootstrap for external extension-point implementations.
 *
 * The community runtime ships no-op extension points (story 0.15). An external
 * consumer — e.g. an enterprise overlay package — registers real
 * implementations by exporting a `register(registry)` function and pointing the
 * `EVO_EXTENSIONS_BOOTSTRAP` env var at that module specifier. The registry
 * instance is passed in so the consumer mutates the SAME singleton the runtime
 * reads, regardless of how its own module graph resolves dependencies.
 *
 * When the env var is unset — the default OSS / standalone case — this is a
 * no-op: the runtime keeps the no-op defaults. This file contains no knowledge
 * of any specific consumer; it is neutral plumbing.
 *
 * Must run once at process start, BEFORE `AppModule.forRoot()` reads the
 * registry (plugin_loader) and before the first request reaches
 * `RuntimeContextMiddleware` (runtime_context).
 */
export async function loadExternalExtensions(): Promise<void> {
  const specifier = process.env.EVO_EXTENSIONS_BOOTSTRAP;
  if (!specifier) {
    return;
  }

  type RegisterFn = (
    registry: typeof EvoExtensionPoints,
  ) => void | Promise<void>;
  const mod = (await import(specifier)) as {
    register?: RegisterFn;
    default?: RegisterFn;
  };
  const register = mod.register ?? mod.default;

  if (typeof register !== 'function') {
    throw new Error(
      `EVO_EXTENSIONS_BOOTSTRAP module '${specifier}' must export a ` +
        `register(registry) function (named export 'register' or default).`,
    );
  }

  await register(EvoExtensionPoints);
}
