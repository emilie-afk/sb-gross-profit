// Child process for tests/collector-exit.test.mjs: one captured download through the real runSteps with a fake
// page, then nothing else. The process must exit on its own right after (no timer left behind).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSteps } from '../../automation/shipstation-export/src/export.mjs';

const mode = process.argv[2];
let handler = null;
const scope = {
  route: async (_pattern, h) => { handler = h; },
  unroute: async () => { handler = null; },
};
const page = {
  context: () => scope,
  locator: () => ({ first: () => ({ click: async () => {
    if (mode === 'click_fails') throw new Error('element not found');
    await handler({
      fetch: async () => ({ status: () => (mode === 'http_500' ? 500 : 200), body: async () => Buffer.from(mode === 'http_500' ? '' : 'a,b\n1,2\n') }),
      fulfill: async () => {},
    });
  } }) }),
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runsteps-'));
const steps = [{ action: 'download', selector: 'x', capture: '**/*.csv', captureScope: 'context', timeout: 300000 }];
try {
  const file = await runSteps(page, steps, {}, dir);
  console.log('ok', fs.statSync(file).size);
} catch (e) {
  console.log('failed', String(e.message).slice(0, 80));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
