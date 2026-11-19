/**
 * catalogManual.js — the manual cost lists build.py applies, as ordered entries.
 * The SKUs and costs are private rules (manualPrimaryCosts, manualListCosts), so
 * build.py and the Worker read the same values from the same document.
 */
import { privateRules } from './privateRules.js';

export const manualPrimaryCosts = () => privateRules().manualPrimaryCosts;
export const manualListCosts = () => privateRules().manualListCosts;
