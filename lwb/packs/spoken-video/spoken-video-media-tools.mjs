import { defineTool } from '@deepseek-ai/dsh-tools'

function result(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

const OPERATION_OUTPUT = { type: 'object', additionalProperties: true }

/** Register the model-facing route for every external or locally expensive media action. */
export function registerSpokenVideoMediaTools(ctx, media, scope) {
  const definitions = [
    ['spoken_video_generate_voiceover', '为已保存的口播稿提交配音生成任务。该操作会调用已配置的本地或远程 TTS 服务，并写入项目媒体产物。', 'startVoiceover', {
      projectId: { type: 'string', required: true }, expectedRevision: { type: 'integer', required: true }, voiceId: { type: 'string' }, voiceName: { type: 'string' }, provider: { type: 'string' }, outputFormat: { type: 'string' }, rate: { type: 'number' }, volume: { type: 'number' }, pitch: { type: 'number' },
    }],
    ['spoken_video_generate_subtitles', '根据已经生成的配音和当前口播稿提交时间轴字幕对齐任务。禁止使用机械切分文稿伪造时间轴。', 'startSubtitles', {
      projectId: { type: 'string', required: true }, expectedRevision: { type: 'integer', required: true }, language: { type: 'string' }, aiOptimize: { type: 'boolean' },
    }],
    ['spoken_video_render', '用已完成的配音和可选时间轴字幕启动 DSH 视觉规划与 Remotion 确定性竖屏视频渲染；Remotion 不可用时自动降级到本机渲染。', 'startVideoRender', {
      projectId: { type: 'string', required: true }, expectedRevision: { type: 'integer', required: true }, visualBrief: { type: 'string', required: true }, renderer: { type: 'string' },
    }],
    ['spoken_video_technical_qc', '对已生成的视频运行 ffprobe 技术质检，检查音轨、1080x1920、30fps、时长与字幕。', 'startTechnicalQc', {
      projectId: { type: 'string', required: true }, expectedRevision: { type: 'integer', required: true },
    }],
  ]
  return definitions.map(([name, description, method, parameters]) => ctx.tools.register(defineTool({
    name,
    description,
    parameters,
    output: { schema: OPERATION_OUTPUT, render: (_args, value) => result(value) },
    execute: async (args, exec) => {
      if (!scope) return media[method](exec.agent, args)
      const context = await scope.assertAgent(exec.agent)
      return scope.request(() => media[method](context, args))
    },
    presentCall: () => ({ card: 'generic', title: description, kind: 'execute' }),
  })))
}
