import type { ScanMode, ScanRecord, StartScanRequest } from '../src/shared/types.js'
import { AzureProvider } from './providers/azure.js'
import { DemoProvider } from './providers/demo.js'
import type {
  ProspectorProvider,
  ProviderCollectRequest,
} from './providers/types.js'
import { ProspectorStore } from './store.js'

export interface ScanServiceProviders {
  demo?: (request: ProviderCollectRequest) => ProspectorProvider
  live?: (request: ProviderCollectRequest) => ProspectorProvider
}

export class ScanInProgressError extends Error {
  constructor() {
    super('A scan is already running')
    this.name = 'ScanInProgressError'
  }
}

function providerName(mode: ScanMode): string {
  return mode === 'live' ? 'azure' : 'demo'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000)
  return 'Unknown scan failure'
}

export class ScanService {
  private readonly providerFactories: Required<ScanServiceProviders>
  private running = false

  constructor(
    private readonly store: ProspectorStore,
    providers: ScanServiceProviders = {},
  ) {
    this.providerFactories = {
      demo: providers.demo ?? (() => new DemoProvider()),
      live:
        providers.live ??
        ((request) => new AzureProvider(undefined, request.tenantId)),
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  async run(input: StartScanRequest): Promise<ScanRecord> {
    if (this.running) throw new ScanInProgressError()
    this.running = true
    let scan: ScanRecord | undefined
    try {
      scan = this.store.startScan(
        input.mode,
        providerName(input.mode),
        input.tenantId,
        input.assessmentName,
        input.assessmentId,
        input.subscriptionIds ?? [],
      )
      const provider = this.providerFactories[input.mode](input)
      const snapshot = await provider.collect({
        tenantId: input.tenantId,
        subscriptionIds: input.subscriptionIds,
      })
      return this.store.completeScan(scan.id, snapshot)
    } catch (error) {
      if (scan) this.store.failScan(scan.id, errorMessage(error))
      throw error
    } finally {
      this.running = false
    }
  }
}
