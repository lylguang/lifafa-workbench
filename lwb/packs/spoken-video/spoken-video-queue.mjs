/**
 * Queueing for the content-schedule module.
 *
 * Before this existed the scheduler ran at most one round per workspace:
 * `tick()` skipped the whole file as soon as any round was active, and
 * `startRun` threw `SPOKEN_VIDEO_SCHEDULE_BUSY` for a second one. Two tasks
 * scheduled for the same minute therefore raced — the loser was swallowed by
 * `.catch(() => {})` at the call site and the operator saw nothing at all.
 * In the 2026-10 data that is two tasks both stamped 21:00 on weekdays.
 *
 * Two different problems are solved here, and they must not be conflated:
 *
 * 1. Same-minute collision. Several tasks become due in one tick. Each gets a
 *    durable queue entry with a position, so nothing is dropped and the order
 *    is visible.
 * 2. Machine contention. Rounds are deliberately serial — rendering saturates
 *    the machine and interleaved failures are far harder to read in the audit
 *    trail. So the queue is a *serial executor*, not a parallel one: one round
 *    at a time, the rest waiting.
 *
 * The queue is pure data plus a small amount of arithmetic; the host owns the
 * I/O and the actual execution.
 */

import { randomUUID } from 'node:crypto'

export const QUEUE_STATUSES = Object.freeze(['waiting', 'active', 'done', 'failed', 'cancelled'])
export const QUEUE_FILE = 'schedule-queue.json'
/** A stale `active` entry means the host died mid-round; see reclaimActive. */
export const QUEUE_MAX_WAITING = 100

export function emptyQueueFile() {
  return { schemaVersion: 1, entries: [] }
}

export function queueEntry(value) {
  return {
    id: String(value?.id || randomUUID()),
    runId: String(value?.runId || ''),
    scheduleId: String(value?.scheduleId || ''),
    scheduleName: String(value?.scheduleName || ''),
    depth: String(value?.depth || ''),
    trigger: QUEUE_STATUSES.includes(value?.trigger) ? value.trigger : (['automatic', 'manual', 'resume'].includes(value?.trigger) ? value.trigger : 'automatic'),
    // 续跑条目指向一条被中断的既有轮次，startRun 靠它复用原记录而不是新建。
    resumeRunId: String(value?.resumeRunId || ''),
    status: QUEUE_STATUSES.includes(value?.status) ? value.status : 'waiting',
    enqueuedAt: String(value?.enqueuedAt || ''),
    // 槽位键 = 计划时间 + 当天分钟。同一分钟内的多次 tick 用它去重，
    // 所以它必须原样存下来，而不是被 enqueuedAt（实际入队时刻）覆盖。
    slotKey: String(value?.slotKey || ''),
    startedAt: value?.startedAt ?? null,
    finishedAt: value?.finishedAt ?? null,
    result: value?.result ?? null,
    reason: value?.reason ?? null,
  }
}

/**
 * Whether an existing queue entry already covers this schedule for this round.
 *
 * The identity of "this round" is the scheduled slot, not the wall clock: two
 * ticks inside the same minute must not enqueue twice, but a manual trigger in
 * the same minute is a distinct request and must go through.
 */
export function alreadyQueued(entries, { scheduleId, trigger, slotKey }) {
  return entries.some((entry) => entry.scheduleId === scheduleId
    && entry.trigger === trigger
    && (!slotKey || entry.slotKey === slotKey))
}

/**
 * Build the next queue state from the current entries.
 *
 * `entries` is the existing list (any order); the result is normalized, newest
 * first, capped at QUEUE_MAX_WAITING so a host that ran unattended for weeks
 * cannot grow an unbounded file.
 *
 * @returns the new list, or `null` when this exact request is already queued —
 *   that is the idempotence the thirty second tick depends on.
 */
export function enqueue(entries, request, now = new Date().toISOString()) {
  const slotKey = request.slotKey || null
  if (alreadyQueued(entries, { scheduleId: request.scheduleId, trigger: request.trigger, slotKey })) return null
  const entry = queueEntry({
    ...request,
    status: 'waiting',
    enqueuedAt: now,
  })
  return [entry, ...entries.map(queueEntry)].slice(0, QUEUE_MAX_WAITING)
}

/** The next entry that may start, or null when nothing is waiting. */
export function nextRunnable(entries) {
  return entries
    .map(queueEntry)
    .filter((entry) => entry.status === 'waiting')
    .sort((left, right) => String(left.enqueuedAt).localeCompare(String(right.enqueuedAt)))[0] || null
}

/** Waiting entries in execution order, with their 1-based position. */
export function waitingWithPosition(entries) {
  return entries
    .map(queueEntry)
    .filter((entry) => entry.status === 'waiting')
    .sort((left, right) => String(left.enqueuedAt).localeCompare(String(right.enqueuedAt)))
    .map((entry, index) => ({ ...entry, position: index + 1 }))
}

/**
 * Whether the executor may start another round right now.
 *
 * `activeEntries` is the count of queue entries currently marked active plus
 * any round the host is running outside the queue. The host passes the number
 * of live rounds it owns so a resumed round and a queued one cannot both run.
 */
export function canStartMore(activeCount, limit = 1) {
  return activeCount < limit
}