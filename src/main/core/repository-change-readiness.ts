export type RepositoryChangePhase = 'STRUCTURE' | 'RELATIONSHIPS' | 'SYMBOL_REFERENCES'

const phases: RepositoryChangePhase[] = ['STRUCTURE', 'RELATIONSHIPS', 'SYMBOL_REFERENCES']

interface Change {
  reached: number
  key?: string
  failed: boolean
  waits: Array<{ promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }>
}

export class RepositoryChangeReadiness {
  private nextId = 0
  private readonly changes = new Map<number, Change>()

  accept(completedPhases = 0, key?: string): number {
    const id = ++this.nextId
    const waits = phases.map(() => {
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      void promise.catch(() => {})
      return { promise, resolve, reject }
    })
    this.changes.set(id, { reached: 0, key, failed: false, waits })
    if (completedPhases > 0) this.advance(id, phases[completedPhases - 1])
    return id
  }

  advance(id: number, phase: RepositoryChangePhase): void {
    const change = this.changes.get(id)
    if (!change) return
    const target = phases.indexOf(phase) + 1
    while (change.reached < target) change.waits[change.reached++].resolve()
    if (target === phases.length) this.changes.delete(id)
  }

  fail(id: number, error: unknown): void {
    const change = this.changes.get(id)
    if (!change) return
    change.failed = true
    for (let index = change.reached; index < phases.length; index++) change.waits[index].reject(error)
  }

  recover(key?: string, minimumReached = 0): void {
    for (const [id, change] of this.changes) {
      if (change.failed && change.reached >= minimumReached && (key === undefined || change.key === key)) this.changes.delete(id)
    }
  }

  cancel(error: Error): void {
    for (const id of this.changes.keys()) this.fail(id, error)
    this.changes.clear()
  }

  barrier(phase: RepositoryChangePhase): Promise<void> {
    const index = phases.indexOf(phase)
    return Promise.all([...this.changes.values()].map((change) => change.waits[index].promise)).then(() => {})
  }
}
