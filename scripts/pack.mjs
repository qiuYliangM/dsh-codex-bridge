import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const destination = join(root, 'dist')
if (!process.env.npm_execpath) throw new Error('Run npm run package')
const pkg = JSON.parse(readFileSync(join(root, 'package.json')))
const { VERSION } = await import('../src/mcp-protocol.js')
if (VERSION !== pkg.version) throw new Error('Runtime and package versions differ')
mkdirSync(destination, { recursive: true })
const [manifest] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd: root, encoding: 'utf8', timeout: 60000 }))
const sha256 = createHash('sha256').update(readFileSync(join(destination, manifest.filename))).digest('hex')
writeFileSync(join(destination, 'PLUGIN-SHA256SUMS'), `${sha256}  ${manifest.filename}\n`)
writeFileSync(join(destination, 'plugin-manifest.json'), JSON.stringify({ ...manifest, sha256 }, null, 2) + '\n')
console.log(`${manifest.filename}: standard DSH bundle, ${manifest.entryCount} files, ${manifest.size} bytes`)
