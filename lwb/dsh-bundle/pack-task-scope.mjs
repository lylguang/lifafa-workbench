/** Tracks complete background promises, including cleanup and queued jobs. */
export class PackTaskScope {
  constructor() {
    this.controller = new AbortController()
    this.pending = new Set()
    this.disposers = new Set()
  }
  get signal() { return this.controller.signal }
  track(promise) {
    const work = Promise.resolve(promise)
    this.pending.add(work)
    work.then(() => this.pending.delete(work), () => this.pending.delete(work))
    return work
  }
  addDisposer(dispose) { this.disposers.add(dispose) }
  async stop() {
    this.controller.abort(new Error('能力包已停止。'))
    for (const dispose of this.disposers) dispose()
    this.disposers.clear()
    // A settled queue entry may start its next entry in finally(). Keep
    // draining until no descendant operation can still write to the workspace.
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}
