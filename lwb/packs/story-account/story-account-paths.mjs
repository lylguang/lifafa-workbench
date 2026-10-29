import { join } from 'node:path'

// The host assigns a dedicated workspace to this pack. All business records and
// media share one child directory inside that owned workspace, so unlinking the
// pack never touches user data and re-linking it finds the same tree again.
export function storyAccountDataPath(workspace, ...segments) {
  return join(workspace, 'data', ...segments)
}
