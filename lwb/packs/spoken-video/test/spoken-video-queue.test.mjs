import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canStartMore,
  emptyQueueFile,
  enqueue,
  nextRunnable,
  QUEUE_MAX_WAITING,
  queueEntry,
  waitingWithPosition,
} from '../spoken-video-queue.mjs'

const request = (overrides = {}) => ({
  scheduleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  scheduleName: '每日口播',
  depth: 'packaging',
  trigger: 'automatic',
  slotKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@2026-10-09T21:0',
  ...overrides,
})

test('two tasks due in the same minute are both queued instead of one being dropped', () => {
  // 改造前：tick 遇到第二个到期任务时 startRun 抛 SPOKEN_VIDEO_SCHEDULE_BUSY，
  // 而调用点的 .catch(() => {}) 把它整个吞掉——用户只看到「今天的任务没跑」。
  let entries = enqueue(emptyQueueFile().entries, request(), '2026-10-09T13:00:01.000Z')
  entries = enqueue(entries, request({
    scheduleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    slotKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb@2026-10-09T21:0',
  }), '2026-10-09T13:00:01.000Z')

  const waiting = waitingWithPosition(entries)
  assert.equal(waiting.length, 2, '同刻到期的两个任务都在队列里')
  assert.deepEqual(waiting.map((entry) => entry.position), [1, 2])
})

test('a thirty second tick cannot enqueue the same slot twice', () => {
  const first = enqueue(emptyQueueFile().entries, request(), '2026-10-09T13:00:01.000Z')
  // 同一分钟内第二次 tick：时间戳不同，但槽位键相同。
  const second = enqueue(first, request(), '2026-10-09T13:00:31.000Z')
  assert.equal(second, null, '同一槽位不重复入队')
})

test('the same task can be queued again for a different slot', () => {
  const first = enqueue(emptyQueueFile().entries, request(), '2026-10-09T13:00:01.000Z')
  const second = enqueue(first, request({ slotKey: request().slotKey.replace('21:0', '09:0') }), '2026-10-10T01:00:01.000Z')
  assert.ok(second, '明天的同一个任务是新一轮，必须能入队')
  assert.equal(waitingWithPosition(second).length, 2)
})

test('a manual trigger is a distinct request and never swallowed by the slot guard', () => {
  const automatic = enqueue(emptyQueueFile().entries, request(), '2026-10-09T13:00:01.000Z')
  const manual = enqueue(automatic, request({ trigger: 'manual' }), '2026-10-09T13:00:05.000Z')
  assert.ok(manual, '手动立即执行必须能插队进来')
})

test('the next runnable entry is the oldest waiting one, and running is serial', () => {
  let entries = enqueue(emptyQueueFile().entries, request({ scheduleName: '先到的' }), '2026-10-09T13:00:01.000Z')
  entries = enqueue(entries, request({
    scheduleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    scheduleName: '后到的',
  }), '2026-10-09T13:05:01.000Z')

  assert.equal(nextRunnable(entries).scheduleName, '先到的', '按入队顺序执行')

  // 一次只跑一个：渲染会打满机器，交错执行的失败在审计里没法读。
  assert.equal(canStartMore(0, 1), true)
  assert.equal(canStartMore(1, 1), false, '已有一轮在跑就不再取下一个')
})

test('a resolved entry stops blocking the queue', () => {
  const first = enqueue(emptyQueueFile().entries, request({ scheduleName: '先到的' }), '2026-10-09T13:00:01.000Z')
  const both = enqueue(first, request({
    scheduleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    scheduleName: '后到的',
  }), '2026-10-09T13:05:01.000Z')
  // 入队时新条目在头部；先按入队时间排好序，再把最早那条结掉。
  const sorted = [...both].sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt))
  const settled = both.map((entry) => (entry.scheduleName === '先到的' ? { ...entry, status: 'done' } : entry))
  assert.equal(nextRunnable(settled).scheduleId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  assert.equal(nextRunnable(both).scheduleName, '先到的')
  assert.equal(sorted[0].scheduleName, '先到的', '队列按入队时间而非数组位置排序')
})

test('a resume entry carries the interrupted run id so the round is continued, not restarted', () => {
  const entries = enqueue(emptyQueueFile().entries, request({
    trigger: 'resume',
    resumeRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  }), '2026-10-09T13:00:01.000Z')
  assert.equal(entries[0].resumeRunId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
})

test('the queue file is capped so an unattended host cannot grow it without bound', () => {
  let entries = []
  for (let index = 0; index < QUEUE_MAX_WAITING + 20; index += 1) {
    entries = enqueue(entries, request({
      scheduleId: `schedule-${index}`,
      slotKey: `schedule-${index}@slot-${index}`,
    }), `2026-10-09T13:${String(index % 60).padStart(2, '0')}:00.000Z`) || entries
  }
  assert.ok(entries.length <= QUEUE_MAX_WAITING)
})

test('a malformed queue row is normalized rather than crashing the read', () => {
  const entry = queueEntry({ scheduleId: 'x', status: 'bogus', trigger: 'nonsense' })
  assert.equal(entry.status, 'waiting')
  assert.equal(entry.trigger, 'automatic')
})
test('a resume can be re-enqueued after a previous resume entry already finished', () => {
  // 2026-10-16 实测回归锁：同一轮被中断多次时，每次都必须能重新入队。
  // 旧去重按 scheduleId+trigger 匹配且 resume 条目没有 slotKey，队列里一条
  // 早已 done 的历史续跑条目把后续所有续跑永久挡死——早7点两轮 interrupted
  // 整整一天无人接手。
  let entries = enqueue(emptyQueueFile().entries, request({
    trigger: 'resume',
    resumeRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    slotKey: null,
  }), '2026-10-16T00:09:45.000Z')
  assert.equal(entries[0].status, 'waiting')
  // 模拟这条续跑已被取走并完成（真正的宿主会把它落成 done）
  entries = entries.map((entry) => queueEntry({ ...entry, status: 'done', finishedAt: '2026-10-16T00:10:00.000Z' }))
  // 同一条轮次再次中断后再次入队：绝不能被历史 done 条目挡住
  const again = enqueue(entries, request({
    trigger: 'resume',
    resumeRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    slotKey: null,
  }), '2026-10-16T12:00:00.000Z')
  assert.ok(again, '再次续跑必须能入队')
  assert.equal(again[0].status, 'waiting')
  // 但同一条轮次已在排队/执行中时不重复入队
  const waiting = enqueue(again, request({
    trigger: 'resume',
    resumeRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    slotKey: null,
  }), '2026-10-16T12:00:30.000Z')
  assert.equal(waiting, null)
})

test('a done resume entry for another run of the same schedule does not block a new resume', () => {
  // 同一计划的两条不同轮次：第一条的 done 续跑条目不能挡第二条。
  const entries = enqueue(emptyQueueFile().entries, request({
    trigger: 'resume',
    resumeRunId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    slotKey: null,
  }), '2026-10-16T00:09:45.000Z')
  const settled = entries.map((entry) => queueEntry({ ...entry, status: 'done' }))
  const next = enqueue(settled, request({
    trigger: 'resume',
    resumeRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    slotKey: null,
  }), '2026-10-16T01:00:00.000Z')
  assert.ok(next, '不同轮次的续跑互不挡')
})
