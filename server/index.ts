import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { loadEnvFile } from 'node:process'
import { z, ZodError } from 'zod'
import {
  recommendationCategories,
  recommendationStatuses,
  type ApiError,
  type HealthResponse,
} from '../src/shared/types.js'
import { ScanInProgressError, ScanService } from './scan-service.js'
import { ProspectorStore, resolveDatabasePath } from './store.js'

const VERSION = '0.1.0'
const MAX_BODY_BYTES = 32 * 1024
const projectRoot = process.cwd()
try {
  loadEnvFile(path.join(projectRoot, '.env'))
} catch (error) {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== 'ENOENT'
  ) {
    throw error
  }
}
const production = process.argv.includes('--production')
const distributionRoot = path.resolve(projectRoot, 'dist')

const startScanSchema = z
  .object({
    mode: z.enum(['demo', 'live']),
    tenantId: z.string().trim().min(1).max(200).optional(),
    subscriptionIds: z
      .array(z.string().trim().min(1).max(200))
      .max(1000)
      .optional(),
  })
  .strict()

const createExceptionSchema = z
  .object({
    reason: z.string().trim().min(3).max(2000),
    createdBy: z.string().trim().min(1).max(320),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()

const createActionSchema = z
  .object({
    title: z.string().trim().min(3).max(300),
    notes: z.string().trim().max(4000).optional(),
    actionType: z.enum(['manual', 'runbook', 'arm', 'external']),
    requestedBy: z.string().trim().min(1).max(320),
  })
  .strict()

const updateActionSchema = z
  .object({
    status: z.enum(['proposed', 'approved', 'running', 'completed', 'failed']),
  })
  .strict()

const recommendationQuerySchema = z.object({
  search: z.string().trim().max(300).optional(),
  category: z.enum(recommendationCategories).optional(),
  status: z.enum(recommendationStatuses).optional(),
  subscriptionId: z.string().trim().max(200).optional(),
  owner: z.string().trim().max(300).optional(),
  minimumConfidence: z.coerce.number().min(0).max(1).optional(),
  includeExcepted: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
})

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function sendError(
  response: ServerResponse,
  status: number,
  error: string,
  details?: string,
): void {
  const payload: ApiError = { error, ...(details ? { details } : {}) }
  sendJson(response, status, payload)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body is too large')
  }
  const contentType = request.headers['content-type']
  if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json')
  }

  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body is too large')
    }
    chunks.push(buffer)
  }
  if (length === 0) throw new HttpError(400, 'A JSON request body is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(400, 'Request body is not valid JSON')
    }
    throw error
  }
}

function validationDetails(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length ? issue.path.join('.') : 'request'
      return `${field}: ${issue.message}`
    })
    .join('; ')
}

function routeId(pathname: string, suffix = ''): string | undefined {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(
    `^/api/recommendations/([^/]+)${escapedSuffix}$`,
  ).exec(pathname)
  if (!match?.[1]) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    throw new HttpError(400, 'Route contains an invalid identifier')
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  store: ProspectorStore,
  scans: ScanService,
): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return false
  const method = request.method ?? 'GET'

  if (method === 'GET' && url.pathname === '/api/health') {
    const connection = store.getConnectionMetadata()
    const payload: HealthResponse = {
      status: 'ok',
      name: 'Azure Prospector',
      version: VERSION,
      mode: connection.mode,
      database: connection.database,
      now: new Date().toISOString(),
    }
    sendJson(response, 200, payload)
    return true
  }

  if (method === 'GET' && url.pathname === '/api/overview') {
    sendJson(response, 200, store.getOverview())
    return true
  }

  if (method === 'GET' && url.pathname === '/api/recommendations') {
    const rawQuery = Object.fromEntries(url.searchParams.entries())
    const query = recommendationQuerySchema.parse(rawQuery)
    sendJson(response, 200, store.listRecommendations(query))
    return true
  }

  if (method === 'GET' && url.pathname === '/api/actions') {
    sendJson(response, 200, store.listActions())
    return true
  }

  if (method === 'POST' && url.pathname === '/api/scans') {
    const input = startScanSchema.parse(await readJson(request))
    const scan = await scans.run(input)
    sendJson(response, 201, scan)
    return true
  }

  const recommendationId = routeId(url.pathname)
  if (method === 'GET' && recommendationId) {
    const recommendation = store.getRecommendation(recommendationId)
    if (!recommendation) throw new HttpError(404, 'Recommendation not found')
    sendJson(response, 200, recommendation)
    return true
  }

  const exceptionId = routeId(url.pathname, '/exceptions')
  if (method === 'POST' && exceptionId) {
    const input = createExceptionSchema.parse(await readJson(request))
    const recommendation = store.createException(
      exceptionId,
      input.reason,
      input.createdBy,
      input.expiresAt,
    )
    if (!recommendation) throw new HttpError(404, 'Recommendation not found')
    sendJson(response, 201, recommendation)
    return true
  }
  if (method === 'DELETE' && exceptionId) {
    if (!store.getRecommendation(exceptionId)) {
      throw new HttpError(404, 'Recommendation not found')
    }
    store.clearException(exceptionId)
    response.writeHead(204, {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end()
    return true
  }

  const actionRecommendationId = routeId(url.pathname, '/actions')
  if (method === 'POST' && actionRecommendationId) {
    const input = createActionSchema.parse(await readJson(request))
    const action = store.createAction(actionRecommendationId, input)
    if (!action) throw new HttpError(404, 'Recommendation not found')
    sendJson(response, 201, action)
    return true
  }

  const actionMatch = /^\/api\/actions\/([^/]+)$/.exec(url.pathname)
  if (method === 'PATCH' && actionMatch?.[1]) {
    let actionId: string
    try {
      actionId = decodeURIComponent(actionMatch[1])
    } catch {
      throw new HttpError(400, 'Route contains an invalid identifier')
    }
    const input = updateActionSchema.parse(await readJson(request))
    const action = store.updateActionStatus(actionId, input.status)
    if (!action) throw new HttpError(404, 'Remediation action not found')
    sendJson(response, 200, action)
    return true
  }

  throw new HttpError(404, 'API endpoint not found')
}

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

async function existingFile(filePath: string): Promise<string | undefined> {
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return undefined
    return await realpath(filePath)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  }
}

async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  rootRealPath: string,
): Promise<void> {
  const fileRealPath = await existingFile(filePath)
  const rootPrefix = rootRealPath.endsWith(path.sep)
    ? rootRealPath
    : `${rootRealPath}${path.sep}`
  if (
    !fileRealPath ||
    (fileRealPath !== rootRealPath && !fileRealPath.startsWith(rootPrefix))
  ) {
    throw new HttpError(404, 'File not found')
  }
  const fileStat = await stat(fileRealPath)
  response.writeHead(200, {
    'Content-Type':
      mimeTypes[path.extname(fileRealPath).toLowerCase()] ??
      'application/octet-stream',
    'Content-Length': fileStat.size,
    'Cache-Control': fileRealPath.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(fileRealPath).pipe(response)
}

async function serveProduction(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed')
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    throw new HttpError(400, 'URL path is invalid')
  }
  if (
    pathname.includes('\0') ||
    pathname.split('/').some((segment) => segment.startsWith('.'))
  ) {
    throw new HttpError(400, 'URL path is invalid')
  }
  const rootRealPath = await realpath(distributionRoot)
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
  const candidate = path.resolve(distributionRoot, relativePath)
  const rootPrefix = distributionRoot.endsWith(path.sep)
    ? distributionRoot
    : `${distributionRoot}${path.sep}`
  if (!candidate.startsWith(rootPrefix)) {
    throw new HttpError(400, 'URL path is invalid')
  }
  const file = await existingFile(candidate)
  if (file) {
    await serveFile(request, response, candidate, rootRealPath)
    return
  }
  const acceptsHtml = (request.headers.accept ?? '').includes('text/html')
  if (acceptsHtml && !path.extname(relativePath)) {
    await serveFile(
      request,
      response,
      path.join(distributionRoot, 'index.html'),
      rootRealPath,
    )
    return
  }
  throw new HttpError(404, 'File not found')
}

async function main(): Promise<void> {
  const store = new ProspectorStore(resolveDatabasePath())
  const scans = new ScanService(store)
  const vite = production
    ? undefined
    : await import('vite').then(({ createServer: createViteServer }) =>
        createViteServer({
          root: projectRoot,
          appType: 'spa',
          server: { middlewareMode: true },
        }),
      )

  const server = createServer((request, response) => {
    void (async () => {
      if (await handleApi(request, response, store, scans)) return
      if (vite) {
        await new Promise<void>((resolve, reject) => {
          const finish = (): void => {
            response.off('close', finish)
            response.off('finish', finish)
            resolve()
          }
          response.once('close', finish)
          response.once('finish', finish)
          vite.middlewares(request, response, (error?: unknown) => {
            response.off('close', finish)
            response.off('finish', finish)
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        })
        if (!response.writableEnded) {
          throw new HttpError(404, 'Page not found')
        }
        return
      }
      await serveProduction(request, response)
    })().catch((error: unknown) => {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof ScanInProgressError
            ? 409
          : error instanceof ZodError
            ? 400
            : 500
      const message =
        error instanceof HttpError
          ? error.message
          : error instanceof ScanInProgressError
            ? error.message
          : error instanceof ZodError
            ? 'Request validation failed'
            : 'Internal server error'
      const details =
        error instanceof HttpError
          ? error.details
          : error instanceof ZodError
            ? validationDetails(error)
            : undefined
      if (status >= 500) {
        const errorName = error instanceof Error ? error.name : 'UnknownError'
        console.error(`[azure-prospector] request failed (${errorName})`)
      }
      if (!response.headersSent) {
        sendError(response, status, message, details)
      } else if (!response.writableEnded) {
        response.destroy()
      }
    })
  })

  const portValue = Number(process.env.PORT ?? 4310)
  const port =
    Number.isInteger(portValue) && portValue > 0 && portValue <= 65_535
      ? portValue
      : 4310
  const host = process.env.HOST?.trim() || '127.0.0.1'
  server.listen(port, host, () => {
    const connection = store.getConnectionMetadata()
    console.log(
      `[azure-prospector] listening on http://${host}:${port} (${production ? 'production' : 'development'}, ${connection.mode} mode)`,
    )
  })

  const shutdown = (): void => {
    server.close(() => {
      void vite?.close().finally(() => {
        store.close()
      })
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

await main()
