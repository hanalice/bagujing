/**
 * C21：对 LIKE 召回的 RAG snippet 做确定性规则打分并排序。
 * 优先级：标题命中 > 要点命中 > 同分类 boost；指定 problemId 固定置顶。
 * 不调用 LLM、不使用 FTS/向量。
 */

/** 标题命中权重（brief_name / 分类 name） */
export const RAG_SCORE_TITLE = 100;
/** 要点命中权重（keyPoints / key_points_json；分类用 groupDesc 近似） */
export const RAG_SCORE_KEYPOINTS = 10;
/** 与请求 categoryId 相同的同分类 boost */
export const RAG_SCORE_CATEGORY_BOOST = 1;

// 规范化查询串，供大小写不敏感包含判断。
const normalizeQuery = (query) => String(query ?? '').trim().toLowerCase();

// 判断文本是否包含规范化后的 query（空 query 视为不命中）。
const textIncludesQuery = (text, qLower) => {
  if (!qLower) return false;
  return String(text ?? '').toLowerCase().includes(qLower);
};

// 从 problem/category snippet 取出可用于要点命中判断的文本。
const getKeyPointsText = (snippet) => {
  if (Array.isArray(snippet?.keyPoints)) {
    return snippet.keyPoints.map((p) => String(p ?? '')).join('\u0000');
  }
  if (snippet?.keyPoints != null) return String(snippet.keyPoints);
  if (snippet?.groupDesc != null || snippet?.group_desc != null) {
    return String(snippet.groupDesc ?? snippet.group_desc ?? '');
  }
  return '';
};

// 取出 snippet 所属分类 id（problem.category / category_id，或 category 自身 id）。
const getSnippetCategoryId = (snippet) => {
  if (snippet?.type === 'category') return snippet.id;
  const raw = snippet?.category ?? snippet?.category_id ?? snippet?.categoryId;
  return raw == null || raw === '' ? null : raw;
};

/**
 * 对单条 snippet 计算规则分（不含置顶逻辑）。
 * @param {object} snippet
 * @param {string} query
 * @param {string|number|null|undefined} categoryId
 * @returns {number}
 */
export function scoreRagSnippet(snippet, query, categoryId) {
  const qLower = normalizeQuery(query);
  let score = 0;

  if (snippet?.type === 'problem') {
    const title = snippet.brief_name ?? snippet.briefName ?? snippet.name;
    if (textIncludesQuery(title, qLower)) score += RAG_SCORE_TITLE;
    if (textIncludesQuery(getKeyPointsText(snippet), qLower)) score += RAG_SCORE_KEYPOINTS;
  } else if (snippet?.type === 'category') {
    if (textIncludesQuery(snippet.name, qLower)) score += RAG_SCORE_TITLE;
    if (textIncludesQuery(getKeyPointsText(snippet), qLower)) score += RAG_SCORE_KEYPOINTS;
  }

  if (categoryId != null && categoryId !== '') {
    const snipCat = getSnippetCategoryId(snippet);
    if (snipCat != null && String(snipCat) === String(categoryId)) {
      score += RAG_SCORE_CATEGORY_BOOST;
    }
  }

  return score;
}

/**
 * 对候选 snippets 打分、降序排序，并在存在 problemId 时将其对应 problem 置顶。
 * 同分 tie-break：保持原召回下标（稳定），再按 id 字符串升序。
 * @param {object[]} snippets
 * @param {{ query?: string, categoryId?: *, problemId?: * }} options
 * @returns {object[]} 带 score 字段的新数组（不修改入参）
 */
export function scoreRagSnippets(snippets, { query = '', categoryId, problemId } = {}) {
  const list = Array.isArray(snippets) ? snippets : [];
  const scored = list.map((snippet, index) => ({
    ...snippet,
    score: scoreRagSnippet(snippet, query, categoryId),
    _recallIndex: index,
  }));

  scored.sort((left, right) => (
    right.score - left.score
    || left._recallIndex - right._recallIndex
    || String(left.id ?? '').localeCompare(String(right.id ?? ''), 'en')
  ));

  if (problemId == null || problemId === '') {
    return stripRecallIndex(scored);
  }

  const pinKey = String(problemId);
  const pinnedIndex = scored.findIndex(
    (s) => s.type === 'problem' && String(s.id) === pinKey,
  );
  if (pinnedIndex < 0) {
    return stripRecallIndex(scored);
  }

  const [pinned] = scored.splice(pinnedIndex, 1);
  // 去掉其它重复的同一 problem id，保证置顶唯一。
  const rest = scored.filter(
    (s) => !(s.type === 'problem' && String(s.id) === pinKey),
  );
  return stripRecallIndex([pinned, ...rest]);
}

// 去掉排序用的内部下标，避免泄漏到调用方。
function stripRecallIndex(items) {
  return items.map((item) => {
    const copy = { ...item };
    delete copy._recallIndex;
    return copy;
  });
}
