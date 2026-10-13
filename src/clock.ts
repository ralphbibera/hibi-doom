// Copyright (C) 2026 Ralph Bibera. SPDX-License-Identifier: GPL-3.0-only
import type { Activity } from './model.ts'

export class ActiveClock {
  private elapsed = 0
  private activeAt: number | null = null
  private now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  read = () =>
    this.elapsed +
    (this.activeAt === null ? 0 : Math.max(0, this.now() - this.activeAt))

  set(activity: Activity) {
    if (activity === 'running') {
      if (this.activeAt === null) this.activeAt = this.now()
    } else if (this.activeAt !== null) {
      this.elapsed = this.read()
      this.activeAt = null
    }
  }
}
