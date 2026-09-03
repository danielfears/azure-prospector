import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  recommendationCategories,
  type ActionStatus,
  type CoverageItem,
  type ExceptionRecord,
  type OverviewResponse,
  type Recommendation,
  type RecommendationQuery,
  type RemediationAction,
  type ScanMode,
  type ScanRecord,
  type SubscriptionSummary,
} from '../src/shared/types.js'
import { createDemoSnapshot } from './providers/demo.js'
import type {
  ProviderSnapshot,
  SnapshotRecommendation,
} from './providers/types.js'

type SqlValue = string | number | null
type Row = Record<string, unknown>

export interface StoreOptions {
  seed?: boolean
}

export interface ConnectionMetadata {
  database: string
  mode: ScanMode
  provider: string
}

interface ActiveScope {
  provider: string
  tenantId?: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function asOptionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : asString(value)
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(asString(value)) as T
}

function activeExceptionJoin(alias = 'e'): string {
  return `LEFT JOIN exceptions ${alias}
    ON ${alias}.recommendation_id = r.id
    AND (
      ${alias}.expires_at IS NULL
      OR julianday(${alias}.expires_at) > julianday(?)
    )`
}

export function resolveDatabasePath(
  configuredPath = process.env.PROSPECTOR_DB_PATH,
): string {
  if (configuredPath === ':memory:') return configuredPath
  return path.resolve(configuredPath || path.join('data', 'azure-prospector.db'))
}

export class ProspectorStore {
  readonly databasePath: string
  private readonly database: DatabaseSync

  constructor(
    databasePath = resolveDatabasePath(),
    options: StoreOptions = {},
  ) {
    this.databasePath = resolveDatabasePath(databasePath)
    if (this.databasePath !== ':memory:') {
      mkdirSync(path.dirname(this.databasePath), { recursive: true })
    }

    this.database = new DatabaseSync(this.databasePath)
    this.database.exec('PRAGMA foreign_keys = ON')
    if (this.databasePath !== ':memory:') {
      this.database.exec('PRAGMA journal_mode = WAL')
    }
    this.initializeSchema()

    if (options.seed !== false && this.isEmpty()) {
      this.seedDemoData()
    }
  }

  close(): void {
    this.database.close()
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        tenant_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        subscriptions_discovered INTEGER NOT NULL DEFAULT 0,
        recommendations_found INTEGER NOT NULL DEFAULT 0,
        estimated_monthly_savings REAL NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        monthly_cost REAL NOT NULL DEFAULT 0,
        potential_monthly_savings REAL NOT NULL DEFAULT 0,
        open_recommendations INTEGER NOT NULL DEFAULT 0,
        owner_coverage REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL,
        resource_count INTEGER NOT NULL DEFAULT 0,
        observed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recommendations (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        source_family TEXT NOT NULL,
        source TEXT NOT NULL,
        source_recommendation_id TEXT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        suggested_action TEXT NOT NULL,
        tenant_id TEXT,
        subscription_id TEXT NOT NULL,
        subscription_name TEXT NOT NULL,
        resource_id TEXT,
        resource_name TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_group TEXT,
        location TEXT,
        estimated_monthly_savings REAL NOT NULL DEFAULT 0,
        current_monthly_cost REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        confidence_band TEXT NOT NULL,
        effort TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_display_name TEXT NOT NULL,
        owner_email TEXT,
        owner_source TEXT NOT NULL,
        owner_confidence REAL NOT NULL,
        evidence_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT,
        last_scan_id TEXT,
        FOREIGN KEY (last_scan_id) REFERENCES scans(id)
      );

      CREATE TABLE IF NOT EXISTS coverage (
        key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        percentage REAL NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT,
        observed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cost_trend (
        provider TEXT NOT NULL,
        period TEXT NOT NULL,
        actual_cost REAL NOT NULL,
        optimized_cost REAL NOT NULL,
        realized_savings REAL NOT NULL,
        currency TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (provider, period)
      );

      CREATE TABLE IF NOT EXISTS exceptions (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS remediation_actions (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        title TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_recommendations_provider_status
        ON recommendations(provider, status);
      CREATE INDEX IF NOT EXISTS idx_recommendations_subscription
        ON recommendations(subscription_id);
      CREATE INDEX IF NOT EXISTS idx_recommendations_category
        ON recommendations(category);
      CREATE INDEX IF NOT EXISTS idx_recommendations_source_family
        ON recommendations(provider, source_family);
      CREATE INDEX IF NOT EXISTS idx_actions_recommendation
        ON remediation_actions(recommendation_id);
      CREATE INDEX IF NOT EXISTS idx_scans_started
        ON scans(started_at DESC);

      CREATE TRIGGER IF NOT EXISTS recommendations_confidence_insert
      BEFORE INSERT ON recommendations
      WHEN NEW.confidence < 0 OR NEW.confidence > 1
      BEGIN
        SELECT RAISE(ABORT, 'recommendation confidence must be between 0 and 1');
      END;

      CREATE TRIGGER IF NOT EXISTS recommendations_confidence_update
      BEFORE UPDATE OF confidence ON recommendations
      WHEN NEW.confidence < 0 OR NEW.confidence > 1
      BEGIN
        SELECT RAISE(ABORT, 'recommendation confidence must be between 0 and 1');
      END;
    `)
  }

  private isEmpty(): boolean {
    const row = this.database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM recommendations) +
          (SELECT COUNT(*) FROM scans) +
          (SELECT COUNT(*) FROM subscriptions) AS count`,
      )
      .get() as Row
    return asNumber(row.count) === 0
  }

  private seedDemoData(): void {
    const snapshot = createDemoSnapshot()
    const scan = this.startScan('demo', snapshot.provider)
    this.upsertCollectedSnapshot(scan.id, snapshot)
    this.finishScan(scan.id)
  }

  private setMetadata(key: string, value: string, now: string): void {
    this.database
      .prepare(
        `INSERT INTO metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE
         SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now)
  }

  private getMetadata(key: string): string | undefined {
    const row = this.database
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(key) as Row | undefined
    return row ? asString(row.value) : undefined
  }

  private getActiveScope(): ActiveScope {
    const provider = this.getMetadata('provider') ?? 'demo'
    const tenantId =
      this.getMetadata('mode') === 'live'
        ? this.getMetadata('tenant_id')
        : undefined
    return { provider, tenantId }
  }

  getConnectionMetadata(): ConnectionMetadata {
    return {
      database:
        this.databasePath === ':memory:'
          ? ':memory:'
          : path.relative(process.cwd(), this.databasePath) || path.basename(this.databasePath),
      mode: this.getMetadata('mode') === 'live' ? 'live' : 'demo',
      provider: this.getMetadata('provider') ?? 'demo',
    }
  }

  startScan(
    mode: ScanMode,
    provider: string,
    tenantId?: string,
  ): ScanRecord {
    const id = randomUUID()
    const startedAt = new Date().toISOString()
    this.database
      .prepare(
        `INSERT INTO scans (
          id, mode, provider, status, tenant_id, started_at, warnings_json
        ) VALUES (?, ?, ?, 'running', ?, ?, '[]')`,
      )
      .run(id, mode, provider, tenantId ?? null, startedAt)
    return this.getScan(id)
  }

  finishScan(id: string): ScanRecord {
    const completedAt = new Date().toISOString()
    const result = this.database
      .prepare(
        `UPDATE scans
         SET status = 'completed', completed_at = ?, error = NULL
         WHERE id = ? AND status = 'running'`,
      )
      .run(completedAt, id)
    if (Number(result.changes) === 0) {
      throw new Error(`Running scan not found: ${id}`)
    }
    return this.getScan(id)
  }

  failScan(id: string, error: string): ScanRecord {
    const completedAt = new Date().toISOString()
    const result = this.database
      .prepare(
        `UPDATE scans
         SET status = 'failed', completed_at = ?, error = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(completedAt, error, id)
    if (Number(result.changes) === 0) {
      throw new Error(`Running scan not found: ${id}`)
    }
    return this.getScan(id)
  }

  private getScan(id: string): ScanRecord {
    const row = this.database
      .prepare('SELECT * FROM scans WHERE id = ?')
      .get(id) as Row | undefined
    if (!row) throw new Error(`Scan not found: ${id}`)
    return this.scanFromRow(row)
  }

  latestScan(scope?: ActiveScope): ScanRecord | undefined {
    const clauses: string[] = []
    const params: SqlValue[] = []
    if (scope) {
      clauses.push('provider = ?')
      params.push(scope.provider)
      if (scope.tenantId) {
        clauses.push('tenant_id = ?')
        params.push(scope.tenantId)
      }
    }
    const row = this.database
      .prepare(
        `SELECT * FROM scans
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(...params) as Row | undefined
    return row ? this.scanFromRow(row) : undefined
  }

  recentScans(limit = 5, scope?: ActiveScope): ScanRecord[] {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)))
    const clauses: string[] = []
    const params: SqlValue[] = []
    if (scope) {
      clauses.push('provider = ?')
      params.push(scope.provider)
      if (scope.tenantId) {
        clauses.push('tenant_id = ?')
        params.push(scope.tenantId)
      }
    }
    params.push(safeLimit)
    const rows = this.database
      .prepare(
        `SELECT * FROM scans
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(...params) as Row[]
    return rows.map((row) => this.scanFromRow(row))
  }

  private scanFromRow(row: Row): ScanRecord {
    return {
      id: asString(row.id),
      mode: asString(row.mode) as ScanRecord['mode'],
      status: asString(row.status) as ScanRecord['status'],
      tenantId: asOptionalString(row.tenant_id),
      startedAt: asString(row.started_at),
      completedAt: asOptionalString(row.completed_at),
      subscriptionsDiscovered: asNumber(row.subscriptions_discovered),
      recommendationsFound: asNumber(row.recommendations_found),
      estimatedMonthlySavings: asNumber(row.estimated_monthly_savings),
      warningCount: asNumber(row.warning_count),
      warnings: parseJson<string[]>(row.warnings_json),
      error: asOptionalString(row.error),
    }
  }

  upsertCollectedSnapshot(scanId: string, snapshot: ProviderSnapshot): void {
    const runningScan = this.database
      .prepare(`SELECT id FROM scans WHERE id = ? AND status = 'running'`)
      .get(scanId)
    if (!runningScan) throw new Error(`Running scan not found: ${scanId}`)
    if (snapshot.mode === 'live' && !snapshot.tenantId) {
      throw new Error('Live snapshots must include a tenant ID')
    }
    for (const recommendation of snapshot.recommendations) {
      if (
        !Number.isFinite(recommendation.confidence) ||
        recommendation.confidence < 0 ||
        recommendation.confidence > 1
      ) {
        throw new Error(
          `Recommendation ${recommendation.id} has confidence outside 0..1`,
        )
      }
    }

    this.database.exec('BEGIN IMMEDIATE')
    try {
      const now = snapshot.collectedAt
      this.setMetadata('mode', snapshot.mode, now)
      this.setMetadata('provider', snapshot.provider, now)
      this.setMetadata('tenant_name', snapshot.tenantName, now)
      this.setMetadata('currency', snapshot.currency, now)
      this.setMetadata('resources', String(snapshot.resources), now)
      this.setMetadata('monthly_cost', String(snapshot.monthlyCost), now)
      if (snapshot.tenantId) {
        this.setMetadata('tenant_id', snapshot.tenantId, now)
      } else {
        this.database.prepare('DELETE FROM metadata WHERE key = ?').run('tenant_id')
      }

      this.database.prepare('DELETE FROM subscriptions').run()
      const subscriptionStatement = this.database.prepare(
        `INSERT INTO subscriptions (
          id, provider, name, state, monthly_cost, potential_monthly_savings,
          open_recommendations, owner_coverage, currency, resource_count, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const subscription of snapshot.subscriptions) {
        subscriptionStatement.run(
          subscription.id,
          snapshot.provider,
          subscription.name,
          subscription.state,
          subscription.monthlyCost,
          subscription.potentialMonthlySavings,
          subscription.openRecommendations,
          subscription.ownerCoverage,
          subscription.currency,
          subscription.resourceCount,
          now,
        )
      }

      this.database.prepare('DELETE FROM coverage').run()
      const coverageStatement = this.database.prepare(
        `INSERT INTO coverage (
          key, provider, label, description, percentage, status, source, action,
          observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const item of snapshot.coverage) {
        coverageStatement.run(
          item.key,
          snapshot.provider,
          item.label,
          item.description,
          item.percentage,
          item.status,
          item.source,
          item.action ?? null,
          now,
        )
      }

      this.database.prepare('DELETE FROM cost_trend').run()
      const trendStatement = this.database.prepare(
        `INSERT INTO cost_trend (
          provider, period, actual_cost, optimized_cost, realized_savings,
          currency, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const point of snapshot.costTrend) {
        trendStatement.run(
          snapshot.provider,
          point.period,
          point.actualCost,
          point.optimizedCost,
          point.realizedSavings,
          snapshot.currency,
          now,
        )
      }

      const recommendationStatement = this.database.prepare(`
        INSERT INTO recommendations (
          id, fingerprint, provider, source_family, source,
          source_recommendation_id, category, title, description,
          suggested_action, tenant_id, subscription_id, subscription_name,
          resource_id, resource_name, resource_type, resource_group, location,
          estimated_monthly_savings, current_monthly_cost, currency, confidence,
          confidence_band, effort, risk, status, owner_display_name, owner_email,
          owner_source, owner_confidence, evidence_json, tags_json, first_seen_at,
          last_seen_at, resolved_at, last_scan_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          provider = excluded.provider,
          source_family = excluded.source_family,
          source = excluded.source,
          source_recommendation_id = excluded.source_recommendation_id,
          category = excluded.category,
          title = excluded.title,
          description = excluded.description,
          suggested_action = excluded.suggested_action,
          tenant_id = excluded.tenant_id,
          subscription_id = excluded.subscription_id,
          subscription_name = excluded.subscription_name,
          resource_id = excluded.resource_id,
          resource_name = excluded.resource_name,
          resource_type = excluded.resource_type,
          resource_group = excluded.resource_group,
          location = excluded.location,
          estimated_monthly_savings = excluded.estimated_monthly_savings,
          current_monthly_cost = excluded.current_monthly_cost,
          currency = excluded.currency,
          confidence = excluded.confidence,
          confidence_band = excluded.confidence_band,
          effort = excluded.effort,
          risk = excluded.risk,
          status = CASE
            WHEN recommendations.status = 'resolved' THEN 'open'
            ELSE recommendations.status
          END,
          owner_display_name = excluded.owner_display_name,
          owner_email = excluded.owner_email,
          owner_source = excluded.owner_source,
          owner_confidence = excluded.owner_confidence,
          evidence_json = excluded.evidence_json,
          tags_json = excluded.tags_json,
          last_seen_at = excluded.last_seen_at,
          resolved_at = CASE
            WHEN recommendations.status = 'resolved' THEN NULL
            ELSE recommendations.resolved_at
          END,
          last_scan_id = excluded.last_scan_id
      `)
      for (const item of snapshot.recommendations) {
        this.runRecommendationUpsert(
          recommendationStatement,
          item,
          snapshot.provider,
          scanId,
        )
      }

      const scannedSubscriptionIds = snapshot.subscriptions.map(
        (subscription) => subscription.id,
      )
      for (const family of snapshot.completeSourceFamilies) {
        if (scannedSubscriptionIds.length === 0) continue
        const subscriptionPlaceholders = scannedSubscriptionIds
          .map(() => '?')
          .join(', ')
        this.database
          .prepare(
            `UPDATE recommendations
             SET status = 'resolved', resolved_at = ?
             WHERE provider = ?
               AND source_family = ?
               AND (
                 (? IS NULL AND tenant_id IS NULL)
                 OR tenant_id = ?
               )
               AND subscription_id IN (${subscriptionPlaceholders})
               AND last_scan_id != ?
               AND status IN ('open', 'accepted', 'in_progress')`,
          )
          .run(
            now,
            snapshot.provider,
            family,
            snapshot.tenantId ?? null,
            snapshot.tenantId ?? null,
            ...scannedSubscriptionIds,
            scanId,
          )
      }

      const estimatedSavings = snapshot.recommendations.reduce(
        (sum, item) => sum + item.estimatedMonthlySavings,
        0,
      )
      this.database
        .prepare(
          `UPDATE scans SET
            tenant_id = COALESCE(?, tenant_id),
            subscriptions_discovered = ?,
            recommendations_found = ?,
            estimated_monthly_savings = ?,
            warning_count = ?,
            warnings_json = ?
           WHERE id = ?`,
        )
        .run(
          snapshot.tenantId ?? null,
          snapshot.subscriptions.length,
          snapshot.recommendations.length,
          estimatedSavings,
          snapshot.warnings.length,
          JSON.stringify(snapshot.warnings),
          scanId,
        )

      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private runRecommendationUpsert(
    statement: ReturnType<DatabaseSync['prepare']>,
    item: SnapshotRecommendation,
    provider: string,
    scanId: string,
  ): void {
    statement.run(
      item.id,
      item.fingerprint,
      provider,
      item.sourceFamily,
      item.source,
      item.sourceRecommendationId ?? null,
      item.category,
      item.title,
      item.description,
      item.suggestedAction,
      item.tenantId ?? null,
      item.subscriptionId,
      item.subscriptionName,
      item.resourceId ?? null,
      item.resourceName,
      item.resourceType,
      item.resourceGroup ?? null,
      item.location ?? null,
      item.estimatedMonthlySavings,
      item.currentMonthlyCost,
      item.currency,
      item.confidence,
      item.confidenceBand,
      item.effort,
      item.risk,
      item.status,
      item.owner.displayName,
      item.owner.email ?? null,
      item.owner.source,
      item.owner.confidence,
      JSON.stringify(item.evidence),
      JSON.stringify(item.tags),
      item.firstSeenAt,
      item.lastSeenAt,
      item.resolvedAt ?? null,
      scanId,
    )
  }

  listRecommendations(query: RecommendationQuery = {}): Recommendation[] {
    const now = new Date().toISOString()
    const scope = this.getActiveScope()
    const clauses = ['r.provider = ?']
    const params: SqlValue[] = [
      now,
      scope.provider,
    ]
    if (scope.tenantId) {
      clauses.push('r.tenant_id = ?')
      params.push(scope.tenantId)
    }

    if (query.search) {
      clauses.push(
        `(LOWER(r.title) LIKE ? OR LOWER(r.description) LIKE ? OR
          LOWER(r.resource_name) LIKE ? OR LOWER(r.resource_group) LIKE ?)`,
      )
      const search = `%${query.search.toLowerCase()}%`
      params.push(search, search, search, search)
    }
    if (query.category) {
      clauses.push('r.category = ?')
      params.push(query.category)
    }
    if (query.status) {
      clauses.push('r.status = ?')
      params.push(query.status)
    }
    if (query.subscriptionId) {
      clauses.push('r.subscription_id = ?')
      params.push(query.subscriptionId)
    }
    if (query.owner) {
      clauses.push(
        `(LOWER(r.owner_display_name) LIKE ? OR LOWER(COALESCE(r.owner_email, '')) LIKE ?)`,
      )
      const owner = `%${query.owner.toLowerCase()}%`
      params.push(owner, owner)
    }
    if (query.minimumConfidence !== undefined) {
      clauses.push('r.confidence >= ?')
      params.push(query.minimumConfidence)
    }
    if (!query.includeExcepted) {
      clauses.push('e.id IS NULL')
    }

    const rows = this.database
      .prepare(
        `SELECT r.*, e.id AS exception_id, e.reason AS exception_reason,
          e.created_by AS exception_created_by,
          e.created_at AS exception_created_at,
          e.expires_at AS exception_expires_at
         FROM recommendations r
         ${activeExceptionJoin()}
         WHERE ${clauses.join(' AND ')}
         ORDER BY r.estimated_monthly_savings DESC, r.confidence DESC, r.id`,
      )
      .all(...params) as Row[]
    return rows.map((row) => this.recommendationFromRow(row))
  }

  getRecommendation(id: string): Recommendation | undefined {
    const now = new Date().toISOString()
    const scope = this.getActiveScope()
    const tenantClause = scope.tenantId ? ' AND r.tenant_id = ?' : ''
    const row = this.database
      .prepare(
        `SELECT r.*, e.id AS exception_id, e.reason AS exception_reason,
          e.created_by AS exception_created_by,
          e.created_at AS exception_created_at,
          e.expires_at AS exception_expires_at
         FROM recommendations r
         ${activeExceptionJoin()}
         WHERE r.id = ?
           AND r.provider = ?
           ${tenantClause}`,
      )
      .get(now, id, scope.provider, ...(scope.tenantId ? [scope.tenantId] : [])) as
      | Row
      | undefined
    return row ? this.recommendationFromRow(row) : undefined
  }

  private recommendationFromRow(row: Row): Recommendation {
    const exceptionId = asOptionalString(row.exception_id)
    const exception: ExceptionRecord | undefined = exceptionId
      ? {
          id: exceptionId,
          recommendationId: asString(row.id),
          reason: asString(row.exception_reason),
          createdBy: asString(row.exception_created_by),
          createdAt: asString(row.exception_created_at),
          expiresAt: asOptionalString(row.exception_expires_at),
        }
      : undefined

    return {
      id: asString(row.id),
      fingerprint: asString(row.fingerprint),
      source: asString(row.source) as Recommendation['source'],
      sourceRecommendationId: asOptionalString(row.source_recommendation_id),
      category: asString(row.category) as Recommendation['category'],
      title: asString(row.title),
      description: asString(row.description),
      suggestedAction: asString(row.suggested_action),
      tenantId: asOptionalString(row.tenant_id),
      subscriptionId: asString(row.subscription_id),
      subscriptionName: asString(row.subscription_name),
      resourceId: asOptionalString(row.resource_id),
      resourceName: asString(row.resource_name),
      resourceType: asString(row.resource_type),
      resourceGroup: asOptionalString(row.resource_group),
      location: asOptionalString(row.location),
      estimatedMonthlySavings: asNumber(row.estimated_monthly_savings),
      currentMonthlyCost: asNumber(row.current_monthly_cost),
      currency: asString(row.currency),
      confidence: asNumber(row.confidence),
      confidenceBand: asString(
        row.confidence_band,
      ) as Recommendation['confidenceBand'],
      effort: asString(row.effort) as Recommendation['effort'],
      risk: asString(row.risk) as Recommendation['risk'],
      status: asString(row.status) as Recommendation['status'],
      owner: {
        displayName: asString(row.owner_display_name),
        email: asOptionalString(row.owner_email),
        source: asString(row.owner_source) as Recommendation['owner']['source'],
        confidence: asNumber(row.owner_confidence),
      },
      evidence: parseJson<Recommendation['evidence']>(row.evidence_json),
      tags: parseJson<Record<string, string>>(row.tags_json),
      firstSeenAt: asString(row.first_seen_at),
      lastSeenAt: asString(row.last_seen_at),
      resolvedAt: asOptionalString(row.resolved_at),
      exception,
    }
  }

  createException(
    recommendationId: string,
    reason: string,
    createdBy: string,
    expiresAt?: string,
  ): Recommendation | undefined {
    if (!this.getRecommendation(recommendationId)) return undefined
    const now = new Date().toISOString()
    const normalizedExpiresAt = expiresAt
      ? new Date(expiresAt).toISOString()
      : undefined
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database
        .prepare('DELETE FROM exceptions WHERE recommendation_id = ?')
        .run(recommendationId)
      this.database
        .prepare(
          `INSERT INTO exceptions (
            id, recommendation_id, reason, created_by, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          recommendationId,
          reason,
          createdBy,
          now,
          normalizedExpiresAt ?? null,
        )
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.getRecommendation(recommendationId)
  }

  clearException(recommendationId: string): boolean {
    if (!this.getRecommendation(recommendationId)) return false
    const result = this.database
      .prepare('DELETE FROM exceptions WHERE recommendation_id = ?')
      .run(recommendationId)
    return Number(result.changes) > 0
  }

  createAction(
    recommendationId: string,
    input: {
      actionType: RemediationAction['actionType']
      title: string
      notes?: string
      requestedBy: string
    },
  ): RemediationAction | undefined {
    if (!this.getRecommendation(recommendationId)) return undefined
    const id = randomUUID()
    const now = new Date().toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database
        .prepare(
          `INSERT INTO remediation_actions (
            id, recommendation_id, action_type, title, notes, status,
            requested_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
        )
        .run(
          id,
          recommendationId,
          input.actionType,
          input.title,
          input.notes ?? null,
          input.requestedBy,
          now,
          now,
        )
      this.syncRecommendationStatus(recommendationId, now)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.getAction(id)
  }

  updateActionStatus(
    id: string,
    status: ActionStatus,
  ): RemediationAction | undefined {
    const scope = this.getActiveScope()
    const tenantClause = scope.tenantId ? ' AND r.tenant_id = ?' : ''
    const existing = this.database
      .prepare(
        `SELECT a.recommendation_id
         FROM remediation_actions a
         JOIN recommendations r ON r.id = a.recommendation_id
         WHERE a.id = ?
           AND r.provider = ?
           ${tenantClause}`,
      )
      .get(id, scope.provider, ...(scope.tenantId ? [scope.tenantId] : [])) as
      | Row
      | undefined
    if (!existing) return undefined

    const now = new Date().toISOString()
    const completedAt = status === 'completed' ? now : null
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database
        .prepare(
          `UPDATE remediation_actions
           SET status = ?, updated_at = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(status, now, completedAt, id)

      const recommendationId = asString(existing.recommendation_id)
      this.syncRecommendationStatus(recommendationId, now)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.getAction(id)
  }

  private syncRecommendationStatus(
    recommendationId: string,
    now: string,
  ): void {
    const row = this.database
      .prepare(
        `SELECT
          COUNT(*) FILTER (WHERE status IN ('approved', 'running')) AS active_count,
          COUNT(*) FILTER (WHERE status = 'proposed') AS proposed_count,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed_count
         FROM remediation_actions
         WHERE recommendation_id = ?`,
      )
      .get(recommendationId) as Row

    const activeCount = asNumber(row.active_count)
    const proposedCount = asNumber(row.proposed_count)
    const completedCount = asNumber(row.completed_count)
    const status =
      activeCount > 0
        ? 'in_progress'
        : proposedCount > 0
          ? 'accepted'
          : completedCount > 0
            ? 'resolved'
            : 'open'
    this.database
      .prepare(
        `UPDATE recommendations
         SET status = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(status, status === 'resolved' ? now : null, recommendationId)
  }

  private getAction(id: string): RemediationAction {
    const row = this.database
      .prepare('SELECT * FROM remediation_actions WHERE id = ?')
      .get(id) as Row | undefined
    if (!row) throw new Error(`Action not found: ${id}`)
    return this.actionFromRow(row)
  }

  listActions(): RemediationAction[] {
    const scope = this.getActiveScope()
    const tenantClause = scope.tenantId ? ' AND r.tenant_id = ?' : ''
    const rows = this.database
      .prepare(
        `SELECT a.*
         FROM remediation_actions a
         JOIN recommendations r ON r.id = a.recommendation_id
         WHERE r.provider = ?
           ${tenantClause}
         ORDER BY a.created_at DESC, a.id DESC`,
      )
      .all(scope.provider, ...(scope.tenantId ? [scope.tenantId] : [])) as Row[]
    return rows.map((row) => this.actionFromRow(row))
  }

  private actionFromRow(row: Row): RemediationAction {
    return {
      id: asString(row.id),
      recommendationId: asString(row.recommendation_id),
      actionType: asString(
        row.action_type,
      ) as RemediationAction['actionType'],
      title: asString(row.title),
      notes: asOptionalString(row.notes),
      status: asString(row.status) as RemediationAction['status'],
      requestedBy: asString(row.requested_by),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      completedAt: asOptionalString(row.completed_at),
    }
  }

  getOverview(): OverviewResponse {
    const scope = this.getActiveScope()
    const provider = scope.provider
    const tenantClause = scope.tenantId ? ' AND r.tenant_id = ?' : ''
    const currency = this.getMetadata('currency') ?? 'USD'
    const now = new Date()
    const nowIso = now.toISOString()
    const expiringAt = new Date(now.getTime() + 30 * 86_400_000).toISOString()
    const summary = this.database
      .prepare(
        `SELECT
          COUNT(*) FILTER (
            WHERE r.status IN ('open', 'accepted', 'in_progress')
          ) AS open_count,
          COUNT(*) FILTER (
            WHERE r.status IN ('open', 'accepted', 'in_progress')
              AND r.confidence_band = 'high'
          ) AS high_confidence_count,
          COUNT(*) FILTER (
            WHERE r.status IN ('open', 'accepted', 'in_progress')
              AND r.owner_source = 'unassigned'
          ) AS unowned_count,
          COALESCE(SUM(r.estimated_monthly_savings) FILTER (
            WHERE r.status IN ('open', 'accepted', 'in_progress')
          ), 0) AS potential_savings
         FROM recommendations r
         ${activeExceptionJoin()}
         WHERE r.provider = ?
           ${tenantClause}
           AND e.id IS NULL`,
      )
      .get(nowIso, provider, ...(scope.tenantId ? [scope.tenantId] : [])) as Row

    const exceptionRow = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM exceptions e
         JOIN recommendations r ON r.id = e.recommendation_id
         WHERE r.provider = ?
           ${tenantClause}
           AND julianday(e.expires_at) > julianday(?)
           AND julianday(e.expires_at) <= julianday(?)`,
      )
      .get(
        provider,
        ...(scope.tenantId ? [scope.tenantId] : []),
        nowIso,
        expiringAt,
      ) as Row

    const categoryRows = this.database
      .prepare(
        `SELECT category, COUNT(*) AS recommendations,
          COALESCE(SUM(r.estimated_monthly_savings), 0) AS savings
         FROM recommendations r
         ${activeExceptionJoin()}
         WHERE r.provider = ?
           ${tenantClause}
           AND r.status IN ('open', 'accepted', 'in_progress')
           AND e.id IS NULL
         GROUP BY r.category`,
      )
      .all(
        nowIso,
        provider,
        ...(scope.tenantId ? [scope.tenantId] : []),
      ) as Row[]
    const categoryMap = new Map(
      categoryRows.map((row) => [asString(row.category), row]),
    )

    const subscriptionRows = this.database
      .prepare(
        `SELECT s.id, s.name, s.state, s.monthly_cost, s.currency,
          COALESCE(a.potential_monthly_savings, 0) AS potential_monthly_savings,
          COALESCE(a.open_recommendations, 0) AS open_recommendations,
          CASE
            WHEN COALESCE(a.open_recommendations, 0) = 0 THEN 100
            ELSE (a.owned_recommendations * 100.0) / a.open_recommendations
          END AS owner_coverage
         FROM subscriptions s
         LEFT JOIN (
           SELECT r.subscription_id,
             COUNT(*) AS open_recommendations,
             COALESCE(SUM(r.estimated_monthly_savings), 0)
               AS potential_monthly_savings,
             COUNT(*) FILTER (WHERE r.owner_source != 'unassigned')
               AS owned_recommendations
           FROM recommendations r
           ${activeExceptionJoin()}
           WHERE r.provider = ?
             ${tenantClause}
             AND r.status IN ('open', 'accepted', 'in_progress')
             AND e.id IS NULL
           GROUP BY r.subscription_id
         ) a ON a.subscription_id = s.id
         WHERE s.provider = ?
         ORDER BY potential_monthly_savings DESC, s.name`,
      )
      .all(
        nowIso,
        provider,
        ...(scope.tenantId ? [scope.tenantId] : []),
        provider,
      ) as Row[]

    const trendRows = this.database
      .prepare(
        `SELECT period, actual_cost, optimized_cost, realized_savings
         FROM cost_trend
         WHERE provider = ?
         ORDER BY period`,
      )
      .all(provider) as Row[]
    const coverage = this.database
      .prepare('SELECT * FROM coverage ORDER BY key')
      .all() as Row[]

    const realizedAllTime = trendRows.reduce(
      (sum, row) => sum + asNumber(row.realized_savings),
      0,
    )
    const lastTrend = trendRows.at(-1)
    const verifiedPeriods = trendRows.filter(
      (row) => asNumber(row.realized_savings) > 0,
    ).length
    const measurementCoverage = trendRows.length
      ? (verifiedPeriods / trendRows.length) * 100
      : 0
    const potentialSavings = asNumber(summary.potential_savings)
    const latest = this.latestScan(scope)

    return {
      generatedAt: nowIso,
      estate: {
        tenantName: this.getMetadata('tenant_name') ?? 'Azure Estate',
        mode: this.getMetadata('mode') === 'live' ? 'live' : 'demo',
        subscriptions: subscriptionRows.length,
        resources: Number(this.getMetadata('resources') ?? 0),
        monthlyCost: Number(this.getMetadata('monthly_cost') ?? 0),
        currency,
        lastScanAt: latest?.completedAt ?? latest?.startedAt,
      },
      savings: {
        currency,
        potentialMonthlySavings: potentialSavings,
        annualizedPotentialSavings: potentialSavings * 12,
        realizedSavingsLast30Days: lastTrend
          ? asNumber(lastTrend.realized_savings)
          : 0,
        realizedSavingsAllTime: realizedAllTime,
        verifiedMeasurementCount: verifiedPeriods,
        measurementCoverage,
      },
      openRecommendations: asNumber(summary.open_count),
      highConfidenceRecommendations: asNumber(summary.high_confidence_count),
      unownedRecommendations: asNumber(summary.unowned_count),
      expiringExceptions: asNumber(exceptionRow.count),
      categories: recommendationCategories.map((category) => {
        const row = categoryMap.get(category)
        return {
          category,
          recommendations: row ? asNumber(row.recommendations) : 0,
          estimatedMonthlySavings: row ? asNumber(row.savings) : 0,
        }
      }),
      subscriptions: subscriptionRows.map(
        (row): SubscriptionSummary => ({
          id: asString(row.id),
          name: asString(row.name),
          state: asString(row.state),
          monthlyCost: asNumber(row.monthly_cost),
          potentialMonthlySavings: asNumber(
            row.potential_monthly_savings,
          ),
          openRecommendations: asNumber(row.open_recommendations),
          ownerCoverage: asNumber(row.owner_coverage),
          currency: asString(row.currency),
        }),
      ),
      costTrend: trendRows.map((row) => ({
        period: asString(row.period),
        actualCost: asNumber(row.actual_cost),
        optimizedCost: asNumber(row.optimized_cost),
        realizedSavings: asNumber(row.realized_savings),
      })),
      coverage: coverage.map(
        (row): CoverageItem => ({
          key: asString(row.key),
          label: asString(row.label),
          description: asString(row.description),
          percentage: asNumber(row.percentage),
          status: asString(row.status) as CoverageItem['status'],
          source: asString(row.source),
          action: asOptionalString(row.action),
        }),
      ),
      recentScans: this.recentScans(5, scope),
    }
  }
}
