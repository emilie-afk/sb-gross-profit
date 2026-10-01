/**
 * gp-verify-background — the same verifier as gp-verify, as a Netlify background
 * function (answers 202 at once; runs up to 15 minutes). The collector posts
 * { snapshotIds } after a Monday run and then reads the week status from the
 * Worker, where each report is written. Counts-only logs, as in gp-verify.
 */
import handler from './gp-verify.mjs';

export default (req, context = {}) => handler(req, { ...context, budgetMs: 13 * 60_000 });
