import { createClient } from '@supabase/supabase-js';

// 환경변수는 Vercel 프로젝트 설정 또는 .env.local 에서 주입.
// anon 키만 프론트에 노출(공개키). service_role 은 절대 여기 두지 않는다.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase =
  url && anonKey ? createClient(url, anonKey) : null;

export const supabaseReady = Boolean(url && anonKey);
