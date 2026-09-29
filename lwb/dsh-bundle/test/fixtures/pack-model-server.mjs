// Manual native DSH smoke-test endpoint. No external calls or real credentials.
// Run with node .../pack-model-server.mjs; configure native DSH defaults with
// http://127.0.0.1:14381/v1, model pack-smoke, key pack-smoke-only.
import { createServer } from 'node:http'

const answer = { name: '独立工作区验收账号', positioning: '验证能力包复用 DSH 默认模型', audience: '本地测试人员', pillars: ['工作区隔离'], boundary: '仅用于本地验收', summary: '本地模拟模型已通过 DSH 子代理返回结构化结果。' }
createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
  if (request.headers.authorization !== 'Bearer pack-smoke-only') { response.writeHead(401).end(); return }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const structured = body.tools?.find((tool) => tool.function?.name?.endsWith('structured_output'))
  console.log(JSON.stringify({ model: body.model, structuredTool: structured?.function.name || null, stream: body.stream }))
  if (!structured) { response.writeHead(400).end('Expected structured-output tool'); return }
  const name = structured.function.name
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'pack-smoke', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'pack-output', type: 'function', function: { name, arguments: JSON.stringify(answer) } }] })
  emit({}, 'tool_calls')
  response.end('data: [DONE]\n\n')
}).listen(14381, '127.0.0.1', () => console.log('Local pack model fixture listening on 14381'))
