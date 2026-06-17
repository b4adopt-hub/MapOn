import { supabase } from '../lib/supabase';

export const EXPERT_TYPES: { v: string; l: string }[] = [
  { v: 'realtor', l: '공인중개사' },
  { v: 'legal', l: '법무사' },
  { v: 'architect', l: '건축사' },
  { v: 'appraiser', l: '감정평가사' },
  { v: 'auction', l: '경매 전문가' },
  { v: 'field', l: '임장 대행 전문가' },
  { v: 'civil', l: '토목·개발행위 전문가' },
  { v: 'other', l: '기타 부동산 실무 전문가' },
];

export const EXPERT_FIELDS: string[] = [
  '토지', '농지', '임야', '창고', '공장', '근린생활시설', '상가',
  '경매', '개발행위', '농취증', '도로접도', '용도지역 분석', '임장 대행', '계약 전 체크',
];

export const STATUS_LABEL: Record<string, string> = {
  pending: '가입 대기',
  docs_required: '서류 제출 필요',
  reviewing: '심사 중',
  revision: '보완 요청',
  approved: '승인 완료',
  restricted: '제한 중',
  suspended: '정지',
  withdrawn: '탈퇴',
};

export interface ExpertInput {
  expert_type: string;
  name: string;
  phone: string;
  region: string;
  office_name: string;
  rep_name: string;
  biz_no: string;
  license_no: string;
  office_addr: string;
  office_phone: string;
  fields: string[];
  intro: string;
}

export interface ExpertRow extends ExpertInput {
  id: string;
  status: string;
  review_note: string | null;
  license_file: string | null;
  biz_file: string | null;
  created_at: string;
}

export async function getMyExpert(userId: string): Promise<ExpertRow | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('experts').select('*').eq('id', userId).maybeSingle();
  return (data as ExpertRow) ?? null;
}

/** 전문가 신청 생성/수정(승인 전). status는 reviewing으로 제출. */
export async function submitExpert(userId: string, input: ExpertInput): Promise<string | null> {
  if (!supabase) return 'Supabase 미연결';
  const row = { id: userId, ...input, status: 'reviewing', updated_at: new Date().toISOString() };
  const { error } = await supabase.from('experts').upsert(row, { onConflict: 'id' });
  return error ? error.message : null;
}

/** 임시 저장(작성 중, status=pending 유지) */
export async function saveExpertDraft(userId: string, input: ExpertInput): Promise<string | null> {
  if (!supabase) return 'Supabase 미연결';
  const row = { id: userId, ...input, updated_at: new Date().toISOString() };
  const { error } = await supabase.from('experts').upsert(row, { onConflict: 'id' });
  return error ? error.message : null;
}

/** 서류 업로드 → 경로 반환 */
export async function uploadDoc(userId: string, kind: 'license' | 'biz', file: File): Promise<{ path?: string; error?: string }> {
  if (!supabase) return { error: 'Supabase 미연결' };
  const ext = file.name.split('.').pop() ?? 'bin';
  const path = `${userId}/${kind}_${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('expert-docs').upload(path, file, { upsert: true });
  if (error) return { error: error.message };
  const col = kind === 'license' ? 'license_file' : 'biz_file';
  await supabase.from('experts').update({ [col]: path }).eq('id', userId);
  return { path };
}
