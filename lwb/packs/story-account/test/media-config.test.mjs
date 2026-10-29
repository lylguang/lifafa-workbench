import test from 'node:test'
import assert from 'node:assert/strict'

import { mediaServiceConfig as spokenVideoConfig } from '../../spoken-video/spoken-video-media.mjs'
import { mediaServiceConfig as storyAccountConfig } from '../story-account-media-config.mjs'

const DEFAULT_BRIDGE = 'http://127.0.0.1:8199'

test('没显式配置桥接地址时 endpointConfigured 为 false（区分默认占位与显式配置）', () => {
  for (const config of [spokenVideoConfig({}), storyAccountConfig({})]) {
    assert.equal(config.endpointConfigured, false, '仅靠默认回退时不应算显式配置')
    // configured / scitigerConfigured 仍表示桥接地址可用（默认占位也算），以保持与
    // 宿主可用性判断、鉴权流程兼容——服务可达性由宿主运行时探测，不在此处臆断。
    assert.equal(config.configured, true, '桥接占位地址仍可用')
    assert.equal(config.scitigerConfigured, true)
    assert.equal(config.baseUrl, DEFAULT_BRIDGE, '有效地址仍应返回默认桥接占位')
  }
})

test('显式配置桥接地址时判为已配置', () => {
  const env = { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://bridge.example.com' }
  for (const config of [spokenVideoConfig(env), storyAccountConfig(env)]) {
    assert.equal(config.configured, true)
    assert.equal(config.endpointConfigured, true)
    assert.equal(config.scitigerConfigured, true)
    assert.equal(config.baseUrl, 'https://bridge.example.com')
  }
})

test('用 SCITIGER_BASE_URL 也能识别为已配置', () => {
  const env = { SCITIGER_BASE_URL: 'http://10.0.0.5:9000' }
  for (const config of [spokenVideoConfig(env), storyAccountConfig(env)]) {
    assert.equal(config.configured, true)
    assert.equal(config.baseUrl, 'http://10.0.0.5:9000')
  }
})

test('两份 mediaServiceConfig 产出完全一致（防止再次分叉）', () => {
  for (const env of [
    {},
    { LWB_SPOKEN_VIDEO_SCITIGER_BASE_URL: 'https://bridge.example.com' },
    { SCITIGER_BASE_URL: 'http://10.0.0.5:9000' },
    { LWB_SPOKEN_VIDEO_TTS_USER_ID: 'u1', LWB_SPOKEN_VIDEO_TTS_PROVIDER: 'scitiger', LWB_SPOKEN_VIDEO_TTS_OUTPUT_FORMAT: 'mp3' },
  ]) {
    assert.deepEqual(spokenVideoConfig(env), storyAccountConfig(env), `两份配置在 ${JSON.stringify(env)} 下不一致`)
  }
})
