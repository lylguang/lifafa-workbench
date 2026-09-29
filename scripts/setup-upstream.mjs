import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor', 'deepseek-harness')
const lock = JSON.parse(await readFile(join(root, 'lwb', 'UPSTREAM.lock.json'), 'utf8'))

const run = (cmd, args, cwd = root) => new Promise((resolveRun, reject) => {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${cmd} exited with code ${code}`)))
})

if (!existsSync(vendor)) {
  await mkdir(join(root, 'vendor'), { recursive: true })
  await run('git', ['clone', lock.repository, vendor])
}
await run('git', ['-C', vendor, 'fetch', '--tags', '--force', 'origin'])
await run('git', ['-C', vendor, 'checkout', '--detach', lock.commit])
await run('corepack', ['pnpm', 'install', '--frozen-lockfile'], vendor)
await run('corepack', ['pnpm', 'run', 'build'], vendor)
console.log(`DeepSeek Harness ${lock.commit} is ready.`)
