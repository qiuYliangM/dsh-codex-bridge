import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const commit = process.argv[2]
if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Usage: node scripts/generate-index.mjs <audited 40-character commit>')
const pkg = JSON.parse(readFileSync(join(root, 'package.json')))
const index = {
  format: 1,
  title: { en: 'DSH Codex Bridge', zh: 'DSH Codex Bridge 插件源' },
  description: { en: 'Maintainer index for the local DSH/Codex bridge.', zh: 'DSH 与 Codex 本机协作桥的维护者插件源。' },
  plugins: [{ name: pkg.name, title: 'DSH Codex Bridge', description: { en: 'Bidirectional local messaging and explicit project/session management for DSH and Codex.', zh: '仅在 DSH 安装，提供与本机 Codex 的双向消息及显式工程、会话管理。' }, author: 'qiuYliangM', homepage: pkg.homepage, repository: { url: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') }, versions: [{ version: pkg.version, publishTimestamp: Math.floor(Date.now() / 1000), source: { type: 'git', url: 'https://github.com/qiuYliangM/dsh-codex-bridge', commit }, engines: { dsh: pkg.engines.dsh } }] }],
}
const destination = join(root, 'market/index.json')
mkdirSync(dirname(destination), { recursive: true })
writeFileSync(destination, JSON.stringify(index, null, 2) + '\n')
console.log(`Index pins ${pkg.name}@${pkg.version} to ${commit}`)
