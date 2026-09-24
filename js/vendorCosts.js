/**
 * Compatibility shim. The engine lives in shared/vendorCosts.js so the browser, the
 * Cloudflare Worker and the test suite all run the same pure module.
 * Existing imports of js/vendorCosts.js keep working unchanged.
 */
export * from '../shared/vendorCosts.js';
