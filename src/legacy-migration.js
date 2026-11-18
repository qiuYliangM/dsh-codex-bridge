import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const begin = '# begin-peerbridge (managed by peerbridge CLI)'
const end = '# end-peerbridge'

// Only the old installer's explicitly owned block is removed. Other profile
// edits, including YAML expressions, are never parsed, evaluated or rewritten.
export function migrateLegacyPatch(path) {
  if (!existsSync(path)) return false
  const original = readFileSync(path, 'utf8')
  const lines = original.split(/\r?\n/)
  const kept = []
  let inside = false; let found = false
  for (const line of lines) {
    if (line.trim() === begin) { if (inside) throw new Error('旧 PeerBridge patch 标记嵌套，未修改配置'); inside = true; found = true; continue }
    if (inside && line.trim() === end) { inside = false; continue }
    if (!inside) kept.push(line)
  }
  if (inside) throw new Error('旧 PeerBridge patch 标记未闭合，未修改配置')
  if (!found) return false
  const hasYaml = kept.some(line => line.trim() && !line.trimStart().startsWith('#'))
  const content = kept.join(original.includes('\r\n') ? '\r\n' : '\n') + (hasYaml ? '' : '\n[]\n')
  const temporary = `${path}.${randomUUID()}.tmp`
  const mode = statSync(path).mode & 0o777
  try {
    writeFileSync(temporary, content, { mode })
    chmodSync(temporary, mode)
    // An external profile editor must not lose edits made while migration was
    // preparing its replacement, even if they are outside our managed block.
    if (readFileSync(path, 'utf8') !== original) throw new Error('DSH profile patch 已被同时修改，未覆盖配置')
    renameSync(temporary, path)
  } finally { try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  return true
}
