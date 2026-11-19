/**
 * Compatibility shim. The engine lives in shared/calculator.js so the browser, the
 * Cloudflare Worker and the test suite all run the same pure module.
 * Existing imports of js/calculator.js keep working unchanged.
 */
export * from '../shared/calculator.js';
