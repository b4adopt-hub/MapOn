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
}

const EMPTY: AuthUser = {
  loading: false, userId: null, email: null, displayName: null,
  isAdmin: false, isExpert: false, expertStatus: null,
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
        supabase.from('profiles').select('role,display_name').eq('id', userId).maybeSingle(),
        supabase.from('experts').select('status').eq('id', userId).maybeSingle(),
      ]);
      setState({
        loading: false, userId, email,
        displayName: (prof as { display_name?: string } | null)?.display_name ?? null,
        isAdmin: (prof as { role?: string } | null)?.role === 'admin',
        isExpert: !!exp,
        expertStatus: (exp as { status?: string } | null)?.status ?? null,
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

  return { ...state, signIn, signUp, signOut };
}
