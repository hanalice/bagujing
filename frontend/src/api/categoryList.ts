import type { QueryParams } from '@/interfaces/query';
import { get } from '@/utils/request';

// 参考 backend/data/categories.ndjson 的结构
export interface CategoryItem {
  time: string;
  url: string;
  groupName: string;
  groupDesc: string;
  id: number;
  name: string;
  type: number;
  count: number;
  ac: number;
  nc: number;
}

export interface CategoryListResponse {
  list: CategoryItem[];
  total: number;
  pageSize: number;
  nextCursor?: number | null;
};

export function getCategories(params?: QueryParams): Promise<CategoryListResponse> {
  return get<CategoryListResponse>('/categories', params);
}

export function getCategoryGroups(): Promise<string[]> {
  return get<string[]>('/category-groups', undefined, { cache: false });
}
