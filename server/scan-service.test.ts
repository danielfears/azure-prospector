import { describe, expect, it } from 'vitest'
import { DemoProvider } from './providers/demo.js'
import type {
  ProspectorProvider,
  ProviderCollectRequest,
  ProviderSnapshot,
} from './providers/types.js'
import { ScanInProgressError, ScanService } from './scan-service.js'
import { ProspectorStore } from './store.js'

describe('ScanService', () => {
  it('keeps demo recommendations idempotent across repeated scans', async () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    const service = new ScanService(store, {
      demo: () => new DemoProvider(),
    })
    try {
      const firstScan = await service.run({ mode: 'demo' })
      const firstRecommendations = store.listRecommendations({
        includeExcepted: true,
      })
      const firstSeen = new Map(
        firstRecommendations.map((item) => [item.id, item.firstSeenAt]),
      )

      const secondScan = await service.run({ mode: 'demo' })
      const secondRecommendations = store.listRecommendations({
        includeExcepted: true,
      })

      expect(firstScan.status).toBe('completed')
      expect(secondScan.status).toBe('completed')
      expect(secondRecommendations).toHaveLength(firstRecommendations.length)
      expect(secondRecommendations.map((item) => item.id).sort()).toEqual(
        firstRecommendations.map((item) => item.id).sort(),
      )
      for (const recommendation of secondRecommendations) {
        expect(recommendation.firstSeenAt).toBe(firstSeen.get(recommendation.id))
      }
      expect(store.recentScans(10)).toHaveLength(2)
      expect(
        store.recentScans(10).every((scan) => scan.status === 'completed'),
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it('rejects an overlapping scan until the current scan completes', async () => {
    const store = new ProspectorStore(':memory:', { seed: false })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider: ProspectorProvider = {
      name: 'deferred-demo',
      mode: 'demo',
      async collect(
        _request: ProviderCollectRequest,
      ): Promise<ProviderSnapshot> {
        await gate
        return new DemoProvider().collect({})
      },
    }
    const service = new ScanService(store, {
      demo: () => provider,
    })

    try {
      const first = service.run({ mode: 'demo' })
      await expect(service.run({ mode: 'demo' })).rejects.toBeInstanceOf(
        ScanInProgressError,
      )
      release?.()
      await expect(first).resolves.toMatchObject({ status: 'completed' })
      await expect(service.run({ mode: 'demo' })).resolves.toMatchObject({
        status: 'completed',
      })
    } finally {
      release?.()
      store.close()
    }
  })
})
