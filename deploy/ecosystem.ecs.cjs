/**
 * 阿里云 ECS（2核 2G，多项目同机部署）专用 PM2 进程配置。
 *
 * 设计约束：
 * 1. 2C2G 未部署 Redis 时采用单实例 fork 模式，避免无共享存储下的内存限流计数翻倍；
 * 2. 单实例内存上限收紧至 500M，为同机后续其他子域名项目与系统留足余量；
 * 3. 生产业务密钥统一在 ECS 本地 /var/lib/bagujing/.env.production 维护，不随发版覆盖；
 * 4. 强制 AI_REQUIRE_SIGNED_HEADERS=true（对齐 B32 生产强制验签基线）。
 */

module.exports = {
  apps: [
    {
      name: 'bagujing-be-prod',
      script: '/opt/bagujing/current/backend/src/server-express.js',
      cwd: '/opt/bagujing/current/backend',

      instances: 1,
      exec_mode: 'fork',

      max_memory_restart: '500M',
      exp_backoff_restart_delay: 100,

      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 5000,

      merge_logs: true,
      out_file: '/opt/bagujing/logs/backend-out.log',
      error_file: '/opt/bagujing/logs/backend-error.log',

      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: '/var/lib/bagujing/.env.production',
        AI_REQUIRE_SIGNED_HEADERS: 'true',
      },
      env_production: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: '/var/lib/bagujing/.env.production',
        AI_REQUIRE_SIGNED_HEADERS: 'true',
      },
    },
  ],
};
