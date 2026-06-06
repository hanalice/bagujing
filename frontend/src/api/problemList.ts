import type { QueryParams } from '@/interfaces/query';
import { get } from '@/utils/request';

export interface ProblemBriefInfo {
  categoryId: number;
  id: number;
  type: number;
  briefName: string;
  count: number;
  level: number; // 题目难度等级 1：简单 2：中等 3：困难
  freq: number;
  keyPoints: string[];
  companies: string[];
}

export interface ProblemListResponse {
  list: ProblemBriefInfo[];
  total: number;
  pageSize: number;
  nextCursor?: number | null;
}

export function getProblems(params?: QueryParams) {
  return get<ProblemListResponse>(
    '/problems',
    params,
  );
}

export function getProblemCompanies(params?: QueryParams) {
  return get<string[]>(
    '/problem-companies',
    params,
    { cache: false },
  );
}

export function getProblemKeyPoints(params?: QueryParams) {
  return get<string[]>(
    '/problem-keypoints',
    params,
    { cache: false },
  );
}
