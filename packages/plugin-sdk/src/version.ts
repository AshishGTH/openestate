/**
 * The plugin contract's own semver, independent of @openestate/api's or
 * any plugin's version. Bumped by the same rule as any public API: MAJOR
 * for a PluginContext/hook-signature/capability removal or breaking
 * change, MINOR for a new optional capability/method, PATCH for no
 * contract change. See CLAUDE.md's Phase 7 decisions for the
 * deprecation policy this version number enforces.
 */
export const CORE_PLUGIN_API_VERSION = '1.0.0';
