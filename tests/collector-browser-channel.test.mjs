/** Both collectors can drive the installed Edge or Chrome (browserChannel) instead of the bundled Chromium. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as SS from '../automation/shipstation-export/src/lib.mjs';
import * as SH from '../automation/shopify-export/src/lib.mjs';

test('collectors: browserChannel selects the installed Edge or Chrome; anything else is a config error', () => {
  for (const lib of [SS, SH]) {
    assert.deepEqual(lib.browserLaunchOptions({}), {});
    assert.deepEqual(lib.browserLaunchOptions({ browserChannel: null }), {});
    assert.deepEqual(lib.browserLaunchOptions({ browserChannel: 'msedge' }), { channel: 'msedge' });
    assert.deepEqual(lib.browserLaunchOptions({ browserChannel: 'chrome' }), { channel: 'chrome' });
    assert.throws(() => lib.browserLaunchOptions({ browserChannel: 'C:\\evil.exe' }), /browserChannel/);
  }
});
