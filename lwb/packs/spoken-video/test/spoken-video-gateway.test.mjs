import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import * as cordis from '../../../../vendor/deepseek-harness/vendor/cordis/lib/index.js'
import { SpokenVideoGateway } from '../gateway.mjs'

/**
 * 2026-11-06 回归：四个方法漏了 decorateRemote，RPC 路由根本不认识它们。
 *
 * 客户端把 404 吞掉了（`.catch(() => null)`），所以界面上看不出任何报错，
 * 只是「队列条」「故障聚类」两块永远是空的，「刚换好 Key 现在就跑」那个按钮
 * 点了没反应。故障聚类里带着 cluster.remedy——也就是「最近为什么失败、
 * 该改什么」的中文修法，用户最需要的那句提示就卡在这里。
 *
 * 这条测试直接读原型上的 Remote 标记：方法只要漏了 decorateRemote，
 * 标记就不存在，RPC 路由也就不会认它。
 */

async function registeredMethods() {
  const ctx = new cordis.Context()
  for (const name of ['spokenVideoProjects', 'spokenVideoContent', 'spokenVideoMedia', 'spokenVideoPublish', 'spokenVideoSchedule']) {
    ctx.provide(name, {})
  }
  ctx.provide('spokenVideoScope', { request: async (operation) => operation })
  ctx.provide('sessionController', {})
  const fiber = ctx.plugin(SpokenVideoGateway)
  await fiber.await()
  const service = ctx.reflect.get('spokenVideo', false)
  assert.ok(service, '口播网关服务应当已经注册')
  return remoteMethods(service).map((method) => method.method)
}

test('the queue, failure-cluster, resume and preflight RPCs are reachable', async () => {
  const names = await registeredMethods()
  for (const method of ['scheduleQueue', 'listScheduleFailures', 'resumeScheduleRun', 'schedulePreflight']) {
    assert.ok(names.includes(method), `${method} 必须注册为 Remote 方法，否则 RPC 调用它只会得到 404`)
  }
})

test('every method the client calls over RPC is actually registered', async () => {
  // 客户端 client.js 里以 spokenVideo/<method> 形式调用的方法名。
  // 少注册一个，界面上对应的那块就是「永远空的」，而且没有任何报错提示。
  const clientCalls = [
    'scheduleQueue', 'listScheduleFailures', 'resumeScheduleRun',
    'listScheduleRuns', 'scheduleRuntimeStatus', 'cancelScheduleRun', 'deleteScheduleRun',
    'startVideoRender', 'startVoiceover', 'startSubtitles', 'cancelMediaRun', 'resumeMediaRun',
  ]
  const names = await registeredMethods()
  const missing = clientCalls.filter((method) => !names.includes(method))
  assert.deepEqual(missing, [], `这些方法客户端在调，但服务端没注册成 Remote 方法：${missing.join(', ')}`)
})
