/**
 * credentials.mjs — read the ShipStation login from Windows Credential Manager
 * ============================================================================
 * The username and password live only in Windows Credential Manager, under a
 * generic credential whose target name is set in config (default
 * "sb-shipstation-export"). They are read at run time into memory, passed to
 * the login form, and never written to disk, a log, the run manifest or the
 * command line.
 *
 * Requires the PowerShell module CredentialManager:
 *   Install-Module CredentialManager -Scope CurrentUser
 *   New-StoredCredential -Target sb-shipstation-export -UserName <user> -Password <pw> -Persist LocalMachine
 *
 * 2FA codes, session cookies and browser tokens are never stored or read here.
 * A 2FA prompt stops the job so a person can complete it (see login.mjs).
 */
import { execFileSync } from 'node:child_process';

export function readWindowsCredential(target) {
  if (!/^[\w.-]{1,128}$/.test(target || '')) throw new Error('Invalid credential target name');
  if (process.platform !== 'win32') throw new Error('Windows Credential Manager is only available on Windows');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Import-Module CredentialManager',
    `$c = Get-StoredCredential -Target '${target}'`,
    'if (-not $c) { exit 3 }',
    '[Console]::Out.Write((@{ u = $c.UserName; p = $c.GetNetworkCredential().Password } | ConvertTo-Json -Compress))',
  ].join('; ');
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
                       { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    throw new Error(e.status === 3 ? `No stored credential named ${target}` : 'Could not read the stored credential');
  }
  const j = JSON.parse(out);
  if (!j.u || !j.p) throw new Error(`Stored credential ${target} is incomplete`);
  return { username: j.u, password: j.p };
}
