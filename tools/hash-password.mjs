#!/usr/bin/env node
/**
 * Produce DASHBOARD_PASSWORD_HASH for the Worker.
 *
 *   node tools/hash-password.mjs | npx wrangler secret put DASHBOARD_PASSWORD_HASH --config worker/wrangler.toml
 *
 * The password is read from the terminal without echo (or from stdin when
 * piped). It is never written to disk, a log, or a command line. Only the
 * PBKDF2 hash is printed.
 */
import { hashPassword } from '../worker/src/auth.js';

async function readPassword() {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    const chunks = []; for await (const c of stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  stderr.write('Dashboard password (input hidden): ');
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let pw = '';
    stdin.on('data', ch => {
      if (ch === '\u0003') { stdin.setRawMode(false); reject(new Error('cancelled')); }
      else if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stderr.write('\n'); resolve(pw); }
      else if (ch === '\u007f') pw = pw.slice(0, -1);
      else pw += ch;
    });
  });
}

const pw = await readPassword();
if (pw.length < 12) { process.stderr.write('Use at least 12 characters.\n'); process.exit(1); }
process.stdout.write(await hashPassword(pw) + '\n');
