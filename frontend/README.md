# frontend

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd) 
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) to make the TypeScript language service aware of `.vue` types.

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

## Backend API (backend)

During development Vite proxies `/api` to `http://localhost:3000` (see `vite.config.ts`).

Start the backend:

```sh
cd ../backend
npm run serve:express
```

Open the AI assistant page at `/assistant`.

## Frontend Monitoring (Sentry)

This project supports monitoring for:

- Vue/JS runtime errors
- API request errors and slow API timings
- AI assistant SSE stream lifecycle (start/first token/done/error)

### 1) Configure environment

Copy `.env.example` and set values:

```sh
cp .env.example .env.production
```

Key variables:

- `VITE_SENTRY_DSN`: Sentry DSN (empty means monitoring is disabled)
- `VITE_SENTRY_TRACES_SAMPLE_RATE`: tracing sample rate, from `0` to `1`
- `VITE_MONITOR_API_SLOW_MS`: threshold for slow API warning events
- `VITE_RELEASE`: release version tag shown in monitoring events
- `VITE_AI_CLIENT_ID`: AI gateway client id (default `web`)
- `VITE_AI_CLIENT_TOKEN`: AI gateway client token (must match backend `AI_CLIENT_CREDENTIALS`)

### 2) Production CSP note

If your static server enables CSP, add Sentry ingest domain to `connect-src`.
For this repo's static server, use `CSP_CONNECT_EXTRA` to append allowed domains.

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```
