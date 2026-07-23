/**
 * Phase 7 commit 1 (plugin-core): PluginRegistryService — pure
 * AsyncLocalStorage/semver logic, no Postgres needed, same "fast,
 * DB-independent" tier as postsales-pdf.test.ts /
 * tenant-context-guardrail.test.ts (CLAUDE.md precedent).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Plugin } from '@openestate/plugin-sdk';
import { CORE_PLUGIN_API_VERSION } from '@openestate/plugin-sdk';
import { PluginRegistryService } from '../src/plugins/plugin-registry.service';

function makePlugin(id: string, coreApiVersion: string): Plugin {
  return {
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      kind: 'vertical',
      coreApiVersion,
      description: 'test fixture',
      configSchema: z.object({}).strict(),
      configFields: [],
      capabilities: [],
    },
    hooks: {},
  };
}

describe('PluginRegistryService (Phase 7 commit 1)', () => {
  it('registers a plugin whose coreApiVersion range is satisfied by the running core version', () => {
    const plugin = makePlugin('compatible', '^1.0.0');
    const registry = new PluginRegistryService([plugin]);
    registry.onModuleInit();

    expect(registry.getActive('compatible')).toBe(plugin);
    expect(registry.getStatus('compatible')).toBe('active');
  });

  it('refuses a plugin whose coreApiVersion range the running core does not satisfy, at load — not per call', () => {
    const plugin = makePlugin('incompatible', '^99.0.0');
    const registry = new PluginRegistryService([plugin]);
    registry.onModuleInit();

    expect(registry.getActive('incompatible')).toBeUndefined();
    expect(registry.getStatus('incompatible')).toBe('version-mismatch');
    const info = registry.getVersionMismatchInfo('incompatible');
    expect(info).toEqual({
      pluginId: 'incompatible',
      requiredRange: '^99.0.0',
      runningCoreVersion: CORE_PLUGIN_API_VERSION,
    });
  });

  it('an unknown pluginId (never registered) is "not-found", distinct from "version-mismatch"', () => {
    const registry = new PluginRegistryService([]);
    registry.onModuleInit();

    expect(registry.getActive('never-heard-of-it')).toBeUndefined();
    expect(registry.getStatus('never-heard-of-it')).toBe('not-found');
    expect(registry.getVersionMismatchInfo('never-heard-of-it')).toBeUndefined();
  });

  it('rejects duplicate plugin ids at boot', () => {
    const registry = new PluginRegistryService([makePlugin('dup', '^1.0.0'), makePlugin('dup', '^1.0.0')]);
    expect(() => registry.onModuleInit()).toThrow(/Duplicate plugin id "dup"/);
  });

  it('listAll() returns every registered plugin regardless of active/version-mismatch status', () => {
    const active = makePlugin('active-one', '^1.0.0');
    const mismatched = makePlugin('mismatched-one', '^99.0.0');
    const registry = new PluginRegistryService([active, mismatched]);
    registry.onModuleInit();

    const all = registry.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.manifest.id).sort()).toEqual(['active-one', 'mismatched-one']);
  });
});
