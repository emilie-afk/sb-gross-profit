/**
 * credentials.mjs — Windows Credential Manager for the Shopify collector
 * =====================================================================
 * Targets (generic credentials, Persist LocalMachine):
 *   sb-shopify-export        dedicated Shopify staff login (username = email, password)
 *   sb-gp-ingest             Worker INGEST_SECRET (shared with the ShipStation job)
 *   sb-gmail-oauth-client    Google OAuth desktop client (username = client id, password = client secret)
 *   sb-gmail-readonly        Gmail refresh token (written by gmail-authorize.mjs; scope gmail.readonly)
 *
 * Values are read into memory at run time and never written to disk, a log,
 * the manifest or a command line. Writing (gmail-authorize only) passes the
 * secret to PowerShell on stdin, not as an argument.
 */
import { execFileSync } from 'node:child_process';
export { readWindowsCredential } from '../../shipstation-export/src/credentials.mjs';

export function writeWindowsCredential(target, username, secret) {
  if (!/^[\w.-]{1,128}$/.test(target || '')) throw new Error('Invalid credential target name');
  if (process.platform !== 'win32') throw new Error('Windows Credential Manager is only available on Windows');
  if (!username || !secret) throw new Error('Nothing to store');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Import-Module CredentialManager',
    '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    `New-StoredCredential -Target '${target}' -UserName $j.u -Password $j.p -Persist LocalMachine | Out-Null`,
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
                 { input: JSON.stringify({ u: username, p: secret }), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch { throw new Error(`Could not store the credential ${target}`); }
}
