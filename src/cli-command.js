import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

// Run npm's JavaScript entry directly on Windows. Passing message text through
// cmd.exe would interpret shell metacharacters and is deliberately unsupported.
export function cliCommand(executable, args = [], { platform = process.platform, env = process.env } = {}) {
  let file = executable
  if (platform === 'win32' && !isAbsolute(file) && !/[\\/]/.test(file)) {
    const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
    const extensions = /\.[^\\/.]+$/.test(file) ? [''] : ['.exe', '.cmd', '.bat', '']
    file = path.split(';').filter(Boolean).flatMap(directory => extensions.map(extension => join(directory, file + extension)))
      .find(candidate => existsSync(candidate)) || file
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const shim = readFileSync(file, 'utf8')
    const relative = /%dp0%[\\/]([^"\r\n]+?\.[cm]?js)"/i.exec(shim)?.[1]
    const script = relative && resolve(dirname(file), relative.split(/[\\/]/).join(sep))
    if (!script || !existsSync(script)) throw new Error(`无法安全解析 Windows CLI 启动器 ${file}；请在配置中指定真实 .exe 或 .js/.mjs 入口`)
    file = script
  }
  return /\.[cm]?js$/i.test(file)
    ? { command: process.execPath, args: [file, ...args] }
    : { command: file, args }
}

export function cliEnvironment(env = process.env) {
  const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const delimiter = process.platform === 'win32' ? ';' : ':'
  return { ...env, [key]: `${dirname(process.execPath)}${delimiter}${env[key] || ''}` }
}
