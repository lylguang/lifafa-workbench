const MAX_TRACE_EVENTS = 32

function isoAt(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function eventId(value) {
  return Number.isSafeInteger(value?.seq) && value.seq >= 0 ? `session-${value.seq}` : null
}

function safeToolName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name && name.length <= 80 && /^[A-Za-z0-9_.:/-]+$/u.test(name) ? name : null
}

/** Create the durable, browser-safe trace container for one DSH child run. */
export function dshTrace() {
  return { childSessionId: null, parentSessionId: null, events: [], sessions: [] }
}

/** Ensure a legacy generation record can receive a DSH trace without dropping its history. */
export function ensureDshTrace(record) {
  if (!record.dsh || typeof record.dsh !== 'object' || Array.isArray(record.dsh)) record.dsh = dshTrace()
  if (!Array.isArray(record.dsh.events)) record.dsh.events = []
  if (!Array.isArray(record.dsh.sessions)) record.dsh.sessions = []
  if (typeof record.dsh.childSessionId !== 'string') record.dsh.childSessionId = null
  if (typeof record.dsh.parentSessionId !== 'string') record.dsh.parentSessionId = null
  return record.dsh
}

/** Register one named child in a multi-agent production trace. */
export function startDshTraceSession(trace, { role, label, childSessionId, parentSessionId }) {
  const existing = trace.sessions.find((session) => session.role === role)
  const session = existing || { role, label, childSessionId: null, parentSessionId: null, events: [] }
  session.label = label
  session.childSessionId = childSessionId
  session.parentSessionId = parentSessionId
  if (!Array.isArray(session.events)) session.events = []
  if (!existing) trace.sessions.push(session)
  trace.childSessionId = childSessionId
  trace.parentSessionId = parentSessionId
  return session
}

/** Append an event to one named child without colliding with another child's seq ids. */
export function appendDshSessionTrace(trace, role, item) {
  const session = trace.sessions.find((candidate) => candidate.role === role)
  if (!session || !item) return false
  const scoped = { ...item, id: `${role}-${item.id}` }
  if (session.events.some((event) => event.id === scoped.id)) return false
  session.events.push(scoped)
  session.events = session.events.slice(-MAX_TRACE_EVENTS)
  appendDshTrace(trace, { ...scoped, label: `${session.label} · ${scoped.label}` })
  return true
}

/** Append one already-redacted event, preserving source order and a bounded audit footprint. */
export function appendDshTrace(trace, item) {
  if (!item || typeof item.id !== 'string' || trace.events.some((event) => event.id === item.id)) return false
  trace.events.push(item)
  trace.events = trace.events.slice(-MAX_TRACE_EVENTS)
  return true
}

/** Project child publication into a user-facing event without exposing the run identifier. */
export function dshChildStarted(at) {
  return { id: 'child-started', at, status: 'running', label: 'DSH 子任务已启动', detail: null }
}

/**
 * Convert a raw DSH Session event into a deliberately small, user-safe execution update.
 * Text, reasoning, prompts, tool arguments, tool results, and unknown event payloads never leave
 * the host-side session log through this projection.
 */
export function projectDshSessionEvent(event, fallbackAt) {
  const id = eventId(event)
  if (!id || !event || typeof event.type !== 'string') return null
  const at = isoAt(event.time, fallbackAt)
  const base = { id, at, detail: null }
  switch (event.type) {
    case 'turn/start': return { ...base, status: 'running', label: 'DSH 已接收生成任务' }
    case 'step/start': return { ...base, status: 'running', label: 'DSH 正在请求模型生成' }
    case 'llm/retry-started': return { ...base, status: 'running', label: '模型请求异常，DSH 正在重试' }
    case 'llm/retry': return { ...base, status: 'done', label: '模型重试步骤结束' }
    case 'tool/call': {
      const name = safeToolName(event.data?.name)
      if (name === 'structured_output') return { ...base, status: 'running', label: 'DSH 正在提交候选结构' }
      return { ...base, status: 'running', label: 'DSH 正在调用工具', detail: name }
    }
    case 'tool/result': return { ...base, status: event.data?.error ? 'error' : 'done', label: event.data?.error ? '一个工具步骤未完成' : '一个工具步骤已完成' }
    case 'approval/asked': return { ...base, status: 'waiting', label: 'DSH 正在等待授权' }
    case 'approval/decided': return { ...base, status: 'done', label: 'DSH 已收到授权决定' }
    case 'turn/end': {
      const reason = event.data?.reason?.kind
      if (reason === 'completed') return { ...base, status: 'done', label: 'DSH 已完成生成' }
      if (reason === 'max-tokens') return { ...base, status: 'running', label: 'DSH 达到单次输出上限，正在继续' }
      return { ...base, status: 'error', label: 'DSH 生成未正常结束' }
    }
    default: return null
  }
}
