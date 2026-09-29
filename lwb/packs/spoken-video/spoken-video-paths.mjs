import { join } from 'node:path'

// The host already assigns a dedicated workspace to this pack. All business
// records and media share one child directory inside that owned workspace.
export function spokenVideoDataPath(workspace, ...segments) {
  return join(workspace, 'data', ...segments)
}
