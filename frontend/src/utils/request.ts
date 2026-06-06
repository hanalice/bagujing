import type { QueryParams } from '@/interfaces/query';
import axios, { type AxiosRequestConfig } from 'axios';
import { captureApiError, captureApiTiming } from '@/monitoring';
import { buildAiAuthHeaders, isAiProtectedPath } from '@/utils/ai-auth';

type RequestMeta = {
  startedAt: number;
  requestId: string;
};

export const createRequestId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/**
 * Get unified authentication and tracing headers
 */
export async function getHeaders(method: string, url: string, data?: any) {
  const requestId = createRequestId();
  const headers: Record<string, string> = {
    'x-request-id': requestId,
  };

  const userToken = localStorage.getItem('token');
  const isAiPath = isAiProtectedPath(url);

  if (userToken) {
    headers['Authorization'] = `Bearer ${userToken}`;
  } else if (isAiPath) {
    const bodyText = JSON.stringify(data ?? {});
    const aiAuth = await buildAiAuthHeaders(method, url, bodyText);
    if (aiAuth.token) {
      headers['Authorization'] = `Bearer ${aiAuth.token}`;
    }
  }
  return headers;
}

const getMeta = (config?: AxiosRequestConfig) => {
  const meta = (config as AxiosRequestConfig & { metadata?: RequestMeta })?.metadata;
  return meta;
};

// 简单的内存缓存
const cacheMap = new Map<string, { data: unknown; expire: number }>();

/**
 * 清除所有 API 缓存
 */
export function clearCache() {
  cacheMap.clear();
}

// 创建 axios 实例
const service = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api', // 使用环境变量
  timeout: 10000, // 请求超时时间
});

// 请求拦截器
service.interceptors.request.use(
  async (config) => {
    const method = String(config.method || 'GET').toUpperCase();
    const url = String(config.url || '');
    
    const headers = await getHeaders(method, url, config.data);
    
    config.headers = config.headers || {};
    Object.assign(config.headers, headers);

    (config as AxiosRequestConfig & { metadata?: RequestMeta }).metadata = {
      startedAt: Date.now(),
      requestId: headers['x-request-id'] || '',
    };

    return config;
  },
  (error) => {
    captureApiError(error, {
      message: 'request_interceptor_error',
    });
    return Promise.reject(error);
  }
);

// 响应拦截器
service.interceptors.response.use(
  (response) => {
    const meta = getMeta(response.config);
    const durationMs = meta ? Date.now() - meta.startedAt : undefined;
    captureApiTiming({
      url: response.config.url,
      method: response.config.method,
      status: response.status,
      durationMs,
      requestId: meta?.requestId,
      ok: true,
    });

    const res = response.data;

    if (res.code !== 0) {
      const businessError = new Error(res.message || 'Error');
      captureApiError(businessError, {
        url: response.config.url,
        method: response.config.method,
        status: response.status,
        durationMs,
        requestId: meta?.requestId,
        ok: false,
        message: 'business_error',
      });
      return Promise.reject(businessError);
    }

    return res?.data;
  },
  (error) => {
    const config = error?.config as AxiosRequestConfig | undefined;
    const meta = getMeta(config);
    const durationMs = meta ? Date.now() - meta.startedAt : undefined;
    captureApiError(error, {
      url: config?.url,
      method: config?.method,
      status: error?.response?.status,
      durationMs,
      requestId: meta?.requestId,
      ok: false,
      message: 'http_error',
    });
    return Promise.reject(error);
  }
);

/**
 * 封装带缓存的请求函数
 * @param config Axios配置，增加 cache 字段 (boolean 或 number，单位毫秒)
 */
export function request<T = unknown>(config: AxiosRequestConfig & { cache?: boolean | number }): Promise<T> {
  const { cache = true, ...axiosConfig } = config;

  // 仅对 GET 请求且开启缓存时生效
  if (cache && (!axiosConfig.method || axiosConfig.method.toLowerCase() === 'get')) {
    // 生成缓存 Key: User + URL + Params
    const profileStr = localStorage.getItem('user_profile');
    let username = 'guest';
    if (profileStr) {
      try {
        const profile = JSON.parse(profileStr);
        username = profile.username || 'guest';
      } catch (e) {
        // ignore
      }
    }
    const key = `${username}:${axiosConfig.url}?${JSON.stringify(axiosConfig.params)}`;
    const cachedItem = cacheMap.get(key);

    const now = Date.now();

    // 命中缓存且未过期
    if (cachedItem && cachedItem.expire > now) {
      return Promise.resolve(cachedItem.data as T);
    }

    // 发起请求并写入缓存
    return service(axiosConfig).then((res) => {
      const ttl = typeof cache === 'number' ? cache : 5 * 60 * 1000; // 默认 5 分钟
      cacheMap.set(key, { data: res, expire: now + ttl });
      return res as T;
    });
  }

  return service(axiosConfig);
}

/**
 * 便捷方法：GET 请求（支持缓存）
 */
export function get<T = unknown>(url: string, params?: QueryParams, options?: { cache?: boolean | number; headers?: Record<string, string>; timeout?: number }): Promise<T> {
  return request<T>({ url, method: 'GET', params, cache: options?.cache, headers: options?.headers, timeout: options?.timeout });
}

/**
 * 便捷方法：POST 请求
 */
export function post<T = unknown>(url: string, data?: unknown, options?: { headers?: Record<string, string>; timeout?: number }): Promise<T> {
  return request<T>({ url, method: 'POST', data, headers: options?.headers, timeout: options?.timeout, cache: false });
}

/**
 * 便捷方法：DELETE 请求
 */
export function del<T = unknown>(url: string, params?: Record<string, unknown>, options?: { headers?: Record<string, string>; timeout?: number }): Promise<T> {
  return request<T>({ url, method: 'DELETE', params, headers: options?.headers, timeout: options?.timeout, cache: false });
}

/**
 * 便捷方法：UPDATE 请求（使用 PUT）
 */
export function update<T = unknown>(url: string, data?: unknown, options?: { headers?: Record<string, string>; timeout?: number }): Promise<T> {
  return request<T>({ url, method: 'PUT', data, headers: options?.headers, timeout: options?.timeout, cache: false });
}

export default service;
