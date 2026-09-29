import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launcher = resolve(root, 'lwb', 'dsh-launcher.mjs')
const temporary = mkdtempSync(resolve(tmpdir(), 'lwb-profile-smoke-'))
let output
try {
  output = execFileSync(process.execPath, [launcher, '--dump-config'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LWB_DSH_HOME: temporary, LWB_PACK_REGISTRY: resolve(temporary, 'packs.json') },
  })
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

const requiredRows = [
  '# == @deepseek-ai/dsh-base',
  '# == @deepseek-ai/dsh-web-app',
  "name: '@deepseek-ai/dsh-client-connection'",
  "name: '@deepseek-ai/dsh-client-ui-conversation'",
  "name: '@deepseek-ai/dsh-client-ui-attachment'",
  "name: '@deepseek-ai/dsh-client-file-upload'",
  "name: '@scitiger-ai/lwb-dsh-bundle'",
  '- id: lwb-client',
]
const missing = requiredRows.filter(row => !output.includes(row))
if (missing.length) throw new Error(`LWB Profile is missing required DSH rows:\n${missing.join('\n')}`)
const multiProviderRow = output.split(/(?=^- id: )/mu).find(row => row.startsWith('- id: llm-pi-ai\n'))
if (!multiProviderRow || /^\s+providers:/mu.test(multiProviderRow)) {
  throw new Error('LWB must retain the native multi-provider adapter without preset provider profiles')
}
if (output.includes('fileIntake:')) throw new Error('The retired LWB upload policy must not be mounted')
if (output.includes("name: '@scitiger-ai/lwb-dsh-bundle'\n  disabled: true")) throw new Error('LWB Bundle is disabled in the effective Profile')
const client = readFileSync(resolve(root, 'lwb', 'dsh-bundle', 'client.js'), 'utf8')
for (const required of ['对话', '场景能力包', '设置']) {
  if (!client.includes(required)) throw new Error(`LWB client is missing ${required}`)
}
for (const retired of ['群聊', 'lwbRooms/', 'GroupChatPage', 'lwbConversations/', 'retiredConversationSessionIds', 'lwbFiles/', 'ConversationFileAttachmentRail', 'conversation.input.attachments', 'conversation.chat.node']) {
  if (client.includes(retired)) throw new Error(`Retired product surface remains in the client: ${retired}`)
}
for (const forbidden of ["name: '@deepseek-ai/dsh-experimental-agent-team'", "name: '@deepseek-ai/dsh-experimental-tool-agent-team'"]) {
  if (output.includes(forbidden)) throw new Error(`Base Profile still mounts retired Agent Team package: ${forbidden}`)
}
const host = readFileSync(resolve(root, 'lwb', 'dsh-bundle', 'index.mjs'), 'utf8')
for (const required of ['LwbArchiveGateway']) {
  if (!host.includes(required)) throw new Error(`LWB host is missing ${required}`)
}
for (const retired of ['LwbGroupRoomGateway', 'LwbGroupRoomStore', 'LwbTeamGateway', 'LwbTeamWorkspaceGateway', 'LwbRetiredConversationGateway', 'LwbFileIntakeGateway', 'LwbFileIntakeStore']) {
  if (host.includes(retired)) throw new Error(`Retired host service is still mounted: ${retired}`)
}

process.stdout.write(`LWB three-module Profile smoke passed (${requiredRows.length} rows)\n`)
