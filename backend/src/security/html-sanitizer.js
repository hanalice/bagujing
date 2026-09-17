/**
 * 服务端 HTML 白名单消毒器（B21 / P0-7）。
 *
 * 职责：大模型生成富文本在写入 SQLite details.answer 之前进行清洗，
 * 建立服务端第一道防线，杜绝存储型 XSS。
 *
 * 契约保证：
 * 1. 严格白名单标签：仅允许常见富文本排版标签，丢弃 <script>、<style>、<iframe> 等危险标签；
 * 2. 彻底封杀所有 on* 行内事件属性；
 * 3. 严格校验 URL 协议：严禁 javascript:、vbscript:、data: 伪协议；
 * 4. 杜绝二次解码与空白混淆绕过。
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'code', 'pre', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div', 'a',
]);

const ALLOWED_ATTRS = new Set([
  'class', 'title',
]);

/**
 * 校验 URL 是否安全（只允许 http://, https://, /, #）
 * 严格防范 java\tscript:, &#x6a;avascript: 等空白与编码混淆
 */
function isSafeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  // 移除所有 ASCII 控制字符及空白（防止 javascript: 协议混淆）
  // eslint-disable-next-line no-control-regex
  const normalized = rawUrl.replace(/[\x00-\x20\s\u00A0]/g, '').toLowerCase();

  if (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('data:')
  ) {
    return false;
  }

  return (
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('/') ||
    normalized.startsWith('#')
  );
}

/**
 * 清洗 HTML 片段
 * @param {string} input - 原始 HTML 片段
 * @returns {string} 消毒后的安全 HTML
 */
export function sanitizeHtml(input) {
  if (typeof input !== 'string') return '';
  let text = input.trim();
  if (!text) return '';

  // 1. 彻底剥离 <script> 与 <style> 及其内部所有内容（包含未闭合片段）
  text = text.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, '');

  // 2. 剥离残余的单边或畸形 script / iframe / object / embed / style 标签
  text = text.replace(/<\/?(?:script|style|iframe|object|embed|applet|meta|link|base)[^>]*>/gi, '');

  // 3. 基于白名单标签与安全属性过滤
  const tagRegex = /<\/?([a-zA-Z0-9]+)([^>]*)>/g;
  let sanitized = text.replace(tagRegex, (match, rawTagName, rawAttrs) => {
    const isClosing = match.startsWith('</');
    const tagName = rawTagName.toLowerCase();

    // 标签不在白名单中：剔除该标签外壳，保留可能存在的合法文本内容
    if (!ALLOWED_TAGS.has(tagName)) {
      return '';
    }

    if (isClosing) {
      return `</${tagName}>`;
    }

    // 处理属性
    const attrRegex = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const safeAttrs = [];
    let safeHref = null;
    let attrMatch;

    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

      // 强行拦截任何 on* 行内事件
      if (attrName.startsWith('on')) {
        continue;
      }

      // 对 <a> 标签单独处理 href
      if (tagName === 'a' && attrName === 'href') {
        if (isSafeUrl(attrValue)) {
          safeHref = attrValue.trim();
        }
        continue;
      }

      // 通用白名单属性（class, title 等）
      if (ALLOWED_ATTRS.has(attrName)) {
        // 清除属性值中的双引号避免注入
        const cleanVal = attrValue.replace(/"/g, '&quot;');
        safeAttrs.push(`${attrName}="${cleanVal}"`);
      }
    }

    if (tagName === 'a') {
      if (safeHref) {
        safeAttrs.unshift(`href="${safeHref.replace(/"/g, '&quot;')}"`);
        safeAttrs.push('target="_blank" rel="noopener noreferrer"');
      } else {
        // 没有安全 href 时，不输出 href 属性
      }
    }

    const attrsString = safeAttrs.length > 0 ? ` ${safeAttrs.join(' ')}` : '';
    return `<${tagName}${attrsString}>`;
  });

  // 4. 最终收敛防御：再次剔除可能漏网的 javascript: 协议与 script 字符串
  sanitized = sanitized.replace(/javascript\s*:/gi, '');
  sanitized = sanitized.replace(/<\/?script/gi, '');

  return sanitized.trim();
}
