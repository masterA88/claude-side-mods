export interface Job {
  run: () => Promise<void>
  /** When it was queued, in the same clock as `now`. */
  at: number
}

/**
 * Background work, one job at a time, in order. A job that waited longer
 * than `maxAgeMs` is dropped: by then the moment it would have shown is gone.
 */
export class JobQueue {
  private jobs: Job[] = []
  private isRunning = false

  constructor(
    private readonly now: () => Promise<number>,
    private readonly onError: (err: unknown) => void,
    private readonly maxAgeMs = 60_000,
  ) {}

  get size(): number {
    return this.jobs.length + (this.isRunning ? 1 : 0)
  }

  push(job: Job): void {
    this.jobs.push(job)
    if (!this.isRunning) void this.drain()
  }

  private async drain(): Promise<void> {
    this.isRunning = true
    try {
      for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
        if ((await this.now()) - job.at > this.maxAgeMs) continue
        try {
          await job.run()
        } catch (err) {
          this.onError(err)
        }
      }
    } finally {
      this.isRunning = false
    }
  }
}
