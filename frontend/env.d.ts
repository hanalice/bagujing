/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_API_BASE_URL?: string
	readonly VITE_SENTRY_DSN?: string
	readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string
	readonly VITE_MONITOR_API_SLOW_MS?: string
	readonly VITE_RELEASE?: string
	readonly VITE_AI_CLIENT_ID?: string
	readonly VITE_AI_CLIENT_SECRET?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

declare const __APP_VERSION__: string
