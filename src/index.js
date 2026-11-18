import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { mountPlugin } from './plugin-runtime.js'

export const name = 'peerbridge-dsh-plugin'
export const inject = ['tools', 'webServer', 'connection', 'profileContext', 'loader']

export const Config = z.object({
  autoConfigureCodex: z.boolean().default(true),
  mcpServerName: z.string().default('peerbridge'),
  codexBin: z.string(),
  codexHome: z.string(),
})

export async function apply(ctx, config) {
  await mountPlugin(ctx, config, defineTool)
}
