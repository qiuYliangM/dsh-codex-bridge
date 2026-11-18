import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'dist/plugin-manifest.json')))
const tarball = join(root, 'dist', manifest.filename)
assert.equal(createHash('sha256').update(readFileSync(tarball)).digest('hex'), manifest.sha256)
const files = new Set(manifest.files.map(file => file.path))
for (const path of ['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'src/index.js', 'src/plugin-runtime.js', 'src/mcp-http.js', 'src/codex-registration.js', 'src/adapters.js', 'scripts/cleanup.mjs', 'vendor/ws/LICENSE']) assert.ok(files.has(path), `Missing plugin file: ${path}`)
for (const path of files) assert.ok(!/(^|\/)(node_modules|\.git|\.peerbridge|\.env|logs)(\/|$)|\.(log|deb|exe|pkg)$/.test(path), `Unexpected file: ${path}`)
const temporary = mkdtempSync(join(tmpdir(), 'bridge bundle '))
try {
  const prefix = join(temporary, 'install with spaces')
  const home = join(temporary, 'home'); mkdirSync(home)
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'codex'), DSH_HOME: join(home, 'dsh'), PEERBRIDGE_HOME: join(home, 'bridge'), npm_config_cache: join(home, 'npm-cache') }
  // The DSH profile supplies these peer dependencies. Prove that the bundle's
  // bridge runtime needs no registry downloads or standalone installation.
  execFileSync(process.execPath, [process.env.npm_execpath, 'install', '--prefix', prefix, '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', tarball], { env, encoding: 'utf8', timeout: 30000 })
  const installed = join(prefix, 'node_modules/peerbridge-dsh-plugin')
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json')))
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(readFileSync(join(installed, pkg.dsh.bundle.patch), 'utf8'), /id: codex-deepseek-bridge/)
  assert.ok(existsSync(join(installed, 'vendor/ws/wrapper.mjs')))
  const script = `import assert from 'node:assert/strict'; const {dispatchMcp}=await import(${JSON.stringify(pathToFileURL(join(installed, 'src/mcp-protocol.js')).href)}); assert.equal((await dispatchMcp('initialize',{protocolVersion:'2025-06-18'})).serverInfo.version,${JSON.stringify(manifest.version)}); assert.equal((await dispatchMcp('tools/list')).tools.length,12);`
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], { env, encoding: 'utf8', timeout: 5000 })
  console.log('Standard DSH bundle: manifest, patch, offline installation and self-contained 12-tool runtime passed.')
} finally { rmSync(temporary, { recursive: true, force: true }) }
