/** Shopify emails large order exports zipped: the collector extracts the one CSV in memory, and refuses anything else. */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { unzipSingleCsv, detectExportFormat } from '../automation/shopify-export/src/lib.mjs';

function zip(entries, { method = 8, flags = 0 } = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text), comp = method === 8 ? zlib.deflateRawSync(data) : data, nm = Buffer.from(name), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm); offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const CSV = 'Name,Email\n#1001,synthetic@example.invalid\n';

test('shopify export zip: one CSV (deflate or stored) is extracted exactly; other zips are refused', () => {
  const z = zip([['orders_export_1.csv', CSV]]);
  assert.equal(detectExportFormat(z), 'zip');
  const out = unzipSingleCsv(z);
  assert.equal(out.body.toString(), CSV);
  assert.equal(detectExportFormat(out.body, 'text/csv'), 'shopify_orders_csv');
  assert.equal(unzipSingleCsv(zip([['orders_export_1.csv', CSV]], { method: 0 })).body.toString(), CSV);
  assert.equal(unzipSingleCsv(zip([['a.csv', CSV], ['b.csv', CSV]])), null, 'two files');
  assert.equal(unzipSingleCsv(zip([['orders.exe', CSV]])), null, 'not a CSV');
  assert.equal(unzipSingleCsv(zip([['orders.csv', CSV]], { flags: 1 })), null, 'encrypted');
  const bad = zip([['orders.csv', CSV]]); bad[40] ^= 0xff;
  assert.equal(unzipSingleCsv(bad), null, 'corrupt data (CRC/inflate)');
  assert.equal(unzipSingleCsv(zip([['orders.csv', 'x'.repeat(5000)]]), { maxBytes: 1000 }), null, 'over the size cap');
  assert.equal(unzipSingleCsv(Buffer.from('not a zip')), null);
});
