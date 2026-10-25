/**
 * PM2 进程管理配置模板文件 (Ecosystem Config Example)
 *
 * 使用说明:
 * 1. 复制本文件为 ecosystem.config.cjs:
 *    cp ecosystem.config.example.cjs ecosystem.config.cjs
 * 2. 进程管理相关配置（内存限制、集群模式、日志等）在此文件中维护；
 *    所有业务密钥、大模型 API、限流与认证参数已统一收敛至 backend/.env (开发) 或 backend/.env.production (生产) 中配置。
 * 3. 运行 PM2:
 *    pm2 start ecosystem.config.cjs --env production
 */

module.exports = {
    apps: [
        {
            name: "bagujing-be-prod",
            script: "./src/server-express.js",
            cwd: "./backend",

            // t3.small has 2 vCPUs, 'max' will spawn 2 instances
            instances: "max",
            exec_mode: "cluster",

            // t3.small has 2GB RAM. Limit to 600M per instance (~1.2G total), leaving 800MB for OS/Nginx/Redis
            max_memory_restart: "600M",
            exp_backoff_restart_delay: 100,

            // Graceful shutdown and startup
            wait_ready: true,
            kill_timeout: 5000,

            // Log management
            merge_logs: true,
            out_file: "../logs/backend-out.log",
            error_file: "../logs/backend-error.log",

            // B32：生产进程强制验签。不改 ai-guard.js 的 ?? 'false'。
            // dotenv 默认不覆盖已有变量，因此这里的 true 优先于 .env 里的缺省。
            env: {
                NODE_ENV: "development",
                DOTENV_CONFIG_PATH: ".env",
                AI_REQUIRE_SIGNED_HEADERS: "true",
            },
            env_production: {
                NODE_ENV: "production",
                DOTENV_CONFIG_PATH: ".env.production",
                AI_REQUIRE_SIGNED_HEADERS: "true",
            }
        }
    ]
};
