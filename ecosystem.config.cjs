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

            env: {
                NODE_ENV: "development",
                DOTENV_CONFIG_PATH: ".env",
            },
            env_production: {
                NODE_ENV: "production",
                DOTENV_CONFIG_PATH: ".env.production",
                PORT: 3000,
                ENABLE_SQLITE: "true",

                // AI Guard
                AI_GUARD_ENABLED: "true",
                AI_REQUIRE_SIGNED_HEADERS: "true",
                AI_ALLOWED_ORIGINS: process.env.AI_ALLOWED_ORIGINS || "https://your-server-domain:*",
                AI_CLIENT_CREDENTIALS: process.env.AI_CLIENT_CREDENTIALS || "web:change_me_client_credentials",

                // LLM 上游配置
                OPENAI_API_KEY: process.env.OPENAI_API_KEY || "change_me",
                OPENAI_MODEL: process.env.OPENAI_MODEL || "deepseek-chat",
                OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "https://api.deepseek.com",

                // 请求大小 & 超时
                AI_MAX_INPUT_CHARS: 1200,
                AI_MAX_COMPLETION_TOKENS: 800,
                AI_UPSTREAM_TIMEOUT_MS: 30000,
                AI_SSE_IDLE_TIMEOUT_MS: 20000,

                // 限流：客户端维度
                AI_RATE_LIMIT_CLIENT_PER_MINUTE: 10,
                AI_RATE_LIMIT_CLIENT_PER_HOUR: 100,
                AI_DAILY_REQUEST_LIMIT_PER_CLIENT: 200,
                AI_DAILY_TOKEN_LIMIT_PER_CLIENT: 50000,
                AI_MAX_CONCURRENCY_PER_CLIENT: 2,

                // 限流：IP 维度
                AI_RATE_LIMIT_IP_PER_MINUTE: 30,

                // 限流：全局每日上限
                AI_GLOBAL_DAILY_REQUEST_LIMIT: 5000,
                AI_GLOBAL_DAILY_TOKEN_LIMIT: 500000,

                // 审计日志
                AI_AUDIT_FILE_PATH: "data/ai-audit.ndjson",
            }
        }
    ]
};
