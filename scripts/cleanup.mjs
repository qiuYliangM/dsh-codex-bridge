#!/usr/bin/env node
import { basename, dirname, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { cleanupCodexRegistration, listCodexRegistrations, registrationLocation } from '../src/codex-registration.js'

const usage = `DSH Codex Bridge cleanup (Node.js 22.19+)
  node scripts/cleanup.mjs [--directory DIR] [--codex-bin PATH]
      [--codex-home DIR] [--server-name NAME] [--profile-dir DIR] [--apply]

Default: inspect only. No tokens are printed.
--apply requires --profile-dir; stop/uninstall that DSH profile's bridge first.
User-modified and foreign MCP connections are preserved. Shared history is kept.`
const flags = new Map([
  ['--directory', 'directory'], ['--codex-bin', 'codexBin'],
  ['--codex-home', 'codexHome'], ['--server-name', 'serverName'], ['--profile-dir', 'profileDir'],
])
function canonical(path) {
  const absolute = resolve(path)
  try { return realpathSync.native(absolute) } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute))
  }
}
const identity = path => process.platform === 'win32' ? canonical(path).toLowerCase() : canonical(path)
const options = { apply: false }
try {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { console.log(usage); process.exit(0) }
    if (args[i] === '--apply') { options.apply = true; continue }
    const key = flags.get(args[i])
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${args[i]}`)
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${args[i]}`)
    options[key] = args[++i]
  }
  if (options.serverName && !/^[A-Za-z0-9_-]{1,64}$/.test(options.serverName)) throw new Error('Invalid --server-name')
  if (options.apply && !options.profileDir) throw new Error('--apply requires --profile-dir to select one DSH profile')
  const recordPath = (codexHome, serverName) => registrationLocation({ ...options, codexHome, serverName, createDirectory: false }).path
  const records = listCodexRegistrations(options)
    .filter(record => (!options.codexHome || identity(recordPath(options.codexHome, record.serverName)) === identity(record.path))
      && (!options.serverName || record.serverName === options.serverName)
      && (!options.profileDir || !record.profileDir || identity(record.profileDir) === identity(options.profileDir)))
  // Addresses come from filenames and explicit selectors, never from mutable
  // record metadata. Corrupt attribution must not redirect cleanup elsewhere.
  const targets = options.codexHome && options.serverName
    ? [{ ...options, codexHome: resolve(options.codexHome) }]
    : records.map(record => ({ ...record, codexHome: options.codexHome || record.codexHome }))
  const results = []
  for (const target of targets) {
    if (target.status) { results.push({ path: target.path, status: target.status }); continue }
    if (!target.codexHome) { results.push({ path: target.path, status: target.status || 'legacy-record-needs-explicit-home' }); continue }
    if (target.path && identity(recordPath(target.codexHome, target.serverName)) !== identity(target.path)) { results.push({ path: target.path, status: 'home-mismatch' }); continue }
    const result = await cleanupCodexRegistration({ ...options, codexHome: target.codexHome, serverName: target.serverName })
    results.push(Object.fromEntries(['status', 'changed', 'path', 'removedTransport', 'removableArtifacts', 'removedArtifacts', 'retainedArtifacts'].filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]])))
  }
  console.log(JSON.stringify({ apply: options.apply, results }, null, 2))
  const refused = new Set(['invalid-record', 'home-mismatch', 'server-mismatch', 'profile-mismatch', 'active', 'user-changed-transport', 'legacy-record-needs-explicit-home', 'cleaned-with-retained-artifacts'])
  if (options.apply && results.some(result => refused.has(result.status) || result.retainedArtifacts?.length)) process.exitCode = 2
} catch (error) {
  const message = String(error.message || error).replace(/Bearer\s+[^\s"']+/gi, 'Bearer REDACTED').replace(/token=[^\s&"']+/g, 'token=REDACTED')
  console.error(message)
  process.exitCode = 1
}
