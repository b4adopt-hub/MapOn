import { useEffect, useState, useCallback } from 'react';
import { supabase } from './supabase';

export interface AuthUser {
  loading: boolean;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
  isExpert: boolean;
  expertStatus: string | null;
  /** 남은 크레딧. 관리자는 무제한(Infinity). 비로그인은 0. */
  credits: number;
}

const EMPTY: AuthUser = {
  loading: false, userId: null, email: null, displayName: null,
  isAdmin: false, isExpert: false, expertStatus: null, credits: 0,
};

/**
 * 공통 인증 훅. 로그인 상태 + 역할(관리자/전문가)을 추적.
 * - profiles.role = 'admin' → isAdmin
 * - experts 행 존재 → isExpert, expertStatus
 */
export function useAuth() {
  const [state, setState] = useState<AuthUser>({ ...EMPTY, loading: true });

  const loadProfile = useCallback(async (userId: string, email: string | null) => {
    if (!supabase) { setState({ ...EMPTY, userId, email }); return; }
    try {
      const [{ data: prof }, { data: exp }] = await Promise.all([
        supabase.from('profiles').select('role,display_name,credits').eq('id', userId).maybeSingle(),
        supabase.from('experts').select('status').eq('id', userId).maybeSingle(),
      ]);
      const isAdmin = (prof as { role?: string } | null)?.role === 'admin';
      setState({
        loading: false, userId, email,
        displayName: (prof as { display_name?: string } | null)?.display_name ?? null,
        isAdmin,
        isExpert: !!exp,
        expertStatus: (exp as { status?: string } | null)?.status ?? null,
        credits: isAdmin ? Infinity : ((prof as { credits?: number } | null)?.credits ?? 0),
      });
    } catch {
      setState({ ...EMPTY, userId, email });
    }
  }, []);

  useEffect(() => {
    if (!supabase) { setState({ ...EMPTY }); return; }
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const s = data.session;
      if (s?.user) loadProfile(s.user.id, s.user.email ?? null);
      else setState({ ...EMPTY });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!active) return;
      if (session?.user) loadProfile(session.user.id, session.user.email ?? null);
      else setState({ ...EMPTY });
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [loadProfile]);

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    if (!supabase) return 'Supabase 미연결';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName: string): Promise<string | null> => {
    if (!supabase) return 'Supabase 미연결';
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { data: { display_name: displayName } },
    });
    return error ? error.message : null;
  }, []);

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut();
  }, []);

  /**
   * 크레딧 차감(원자적, 서버 RPC). amount만큼 차감(기본 1). 성공 시 로컬 상태도 갱신.
   * 반환: { ok:true, remaining } 성공 / { ok:false, reason } 실패.
   * 관리자는 서버가 -1(무한) 반환 → remaining=Infinity.
   */
  const consumeCredit = useCallback(async (amount: number = 1): Promise<
    { ok: true; remaining: number } | { ok: false; reason: 'auth' | 'insufficient' | 'error' }
  > => {
    if (!supabase) return { ok: false, reason: 'error' };
    const { data, error } = await supabase.rpc('consume_credit', { p_amount: amount });
    if (error) {
      const msg = error.message || '';
      if (msg.includes('INSUFFICIENT_CREDITS')) return { ok: false, reason: 'insufficient' };
      if (msg.includes('AUTH_REQUIRED')) return { ok: false, reason: 'auth' };
      return { ok: false, reason: 'error' };
    }
    const remaining = typeof data === 'number' && data >= 0 ? data : Infinity;
    setState(prev => ({ ...prev, credits: remaining }));
    return { ok: true, remaining };
  }, []);

  return { ...state, signIn, signUp, signOut, consumeCredit };
}
