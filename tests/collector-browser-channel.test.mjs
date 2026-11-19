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

test('collectors: Chrome gets its own profile folder (it cannot read the Edge/Chromium saved session)', () => {
  const dir = process.platform === 'win32' ? 'C:\\sb-test-local' : '/var/tmp/sb-test-local';
  for (const lib of [SS, SH]) {
    const p = c => lib.localPaths({ localDir: dir, ...(c ? { browserChannel: c } : {}) }).profile;
    assert.ok(p(null).endsWith('profile') && p('msedge').endsWith('profile'));
    assert.ok(p('chrome').endsWith('profile-chrome'));
  }
});
