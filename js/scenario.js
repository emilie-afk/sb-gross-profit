/**
 * Compatibility shim. The engine lives in shared/scenario.js so the browser, the
 * Cloudflare Worker and the test suite all run the same pure module.
 * Existing imports of js/scenario.js keep working unchanged.
 */
export * from '../shared/scenario.js';
