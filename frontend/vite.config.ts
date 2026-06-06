import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import UnoCSS from 'unocss/vite'

import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isProd = mode === 'production'

  return {
    plugins: [vue(), !isProd && vueDevTools(), UnoCSS(), basicSsl()].filter(Boolean),
    define: {
      __VUE_OPTIONS_API__: false,
      __VUE_PROD_DEVTOOLS__: false,
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.1.0'),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      sourcemap: !isProd,
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3000', // remote API
          changeOrigin: true,
          // remove the /api prefix before sending to target
          rewrite: (path) => path.replace(/^\/api/, '/api'),
          // set secure: false if target uses self-signed https
          secure: false,
        },
      },
    },
  }
})
