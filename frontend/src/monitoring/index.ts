import * as Sentry from '@sentry/vue'
import type { App } from 'vue'
import type { Router } from 'vue-router'

type InitMonitoringOptions = {
  app: App
  router: Router
}

type ApiTelemetry = {
  url?: string
  method?: string
  status?: number
  durationMs?: number
  requestId?: string
  ok?: boolean
}

type AiEventLevel = 'info' | 'warning' | 'error'

const getDsn = () => String(import.meta.env.VITE_SENTRY_DSN || '').trim()
const isEnabled = () => getDsn().length > 0

const toNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const getTracesSampleRate = () => Math.max(0, Math.min(1, toNumber(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE, 0.2)))
const getSlowApiThreshold = () => Math.max(200, toNumber(import.meta.env.VITE_MONITOR_API_SLOW_MS, 1500))

const normalizeUrl = (url?: string) => {
  if (!url) return '/unknown'
  return url.split('?')[0] || '/unknown'
}

export const initMonitoring = ({ app, router }: InitMonitoringOptions) => {
  if (!isEnabled()) return

  Sentry.init({
    app,
    dsn: getDsn(),
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE || import.meta.env.MODE,
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
    integrations: [
      Sentry.browserTracingIntegration({
        router,
      }),
      Sentry.replayIntegration(),
    ],
    // Tracing
    tracesSampleRate: getTracesSampleRate(),
    // Set 'tracePropagationTargets' to control for which URLs distributed tracing should be enabled
    tracePropagationTargets: (import.meta.env.VITE_TRACE_PROPAGATION_TARGETS || 'localhost,/api').split(',').map((s: string) => s.trim()).filter(Boolean),
    // Session Replay
    replaysSessionSampleRate: 0.1, // This sets the sample rate at 10%. You may want to change it to 100% while in development and then sample at a lower rate in production.
    replaysOnErrorSampleRate: 1.0, // If you're not already sampling the entire session, change the sample rate to 100% when sampling sessions where errors occur.,
    // Logs
    enableLogs: true
  })
}

export const isMonitoringEnabled = () => isEnabled()

export const captureApiTiming = (payload: ApiTelemetry) => {
  if (!isEnabled()) return

  const method = (payload.method || 'GET').toUpperCase()
  const url = normalizeUrl(payload.url)
  const duration = Number(payload.durationMs || 0)

  Sentry.addBreadcrumb({
    category: 'http.timing',
    level: 'info',
    message: `${method} ${url}`,
    data: {
      method,
      url,
      status: payload.status,
      durationMs: duration,
      requestId: payload.requestId,
      ok: payload.ok,
    },
  })

  if (duration >= getSlowApiThreshold()) {
    Sentry.captureMessage('api_slow_request', {
      level: 'warning',
      tags: {
        monitor_type: 'api_timing',
        method,
        status: String(payload.status || ''),
      },
      extra: {
        url,
        durationMs: duration,
        requestId: payload.requestId,
      },
    })
  }
}

export const captureApiError = (error: unknown, payload: ApiTelemetry & { message?: string }) => {
  if (!isEnabled()) return

  Sentry.captureException(error, {
    tags: {
      monitor_type: 'api_error',
      method: (payload.method || 'GET').toUpperCase(),
      status: String(payload.status || ''),
    },
    extra: {
      url: normalizeUrl(payload.url),
      durationMs: payload.durationMs,
      requestId: payload.requestId,
      ok: payload.ok,
      message: payload.message,
    },
  })
}

export const captureUiError = (error: unknown, source: string, extra?: Record<string, unknown>) => {
  if (!isEnabled()) return

  Sentry.captureException(error, {
    tags: {
      monitor_type: 'ui_error',
      source,
    },
    extra,
  })
}

export const captureAiEvent = (eventName: string, level: AiEventLevel, payload?: Record<string, unknown>) => {
  if (!isEnabled()) return

  Sentry.addBreadcrumb({
    category: 'ai.stream',
    message: eventName,
    level: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
    data: payload,
  })

  if (level !== 'info') {
    Sentry.captureMessage(`ai_${eventName}`, {
      level: level === 'error' ? 'error' : 'warning',
      tags: {
        monitor_type: 'ai_stream',
      },
      extra: payload,
    })
  }
}
