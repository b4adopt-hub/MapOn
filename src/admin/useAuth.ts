import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface AuthState {
  loading: boolean;
  userId: string | null;
  email: string | null;
  isAdmin: boolean;
}

/**
 * 관리자 인증 훅.
 * - Supabase 세션을 구독해 로그인 상태를 추적
 * - profiles.role = 'admin' 인지 확인(RLS로 본인 행만 읽힘)
 * 화면에서 isAdmin이 false면 어떤 관리 데이터도 보여주지 않는다.
 */
export function useAuth(): AuthState & {
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
} {
  const [state, setState] = useState<AuthState>({
    loading: true, userId: null, email: null, isAdmin: false,
  });

  const loadRole = useCallback(async (userId: string, email: string | null) => {
    if (!supabase) { setState({ loading: false, userId, email, isAdmin: false }); return; }
    try {
      const { data } = await supabase
        .from('profiles').select('role').eq('id', userId).maybeSingle();
      const isAdmin = (data as { role?: string } | null)?.role === 'admin';
      setState({ loading: false, userId, email, isAdmin });
    } catch {
      setState({ loading: false, userId, email, isAdmin: false });
    }
  }, []);

  useEffect(() => {
    if (!supabase) { setState({ loading: false, userId: null, email: null, isAdmin: false }); return; }
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const s = data.session;
      if (s?.user) loadRole(s.user.id, s.user.email ?? null);
      else setState({ loading: false, userId: null, email: null, isAdmin: false });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!active) return;
      if (session?.user) loadRole(session.user.id, session.user.email ?? null);
      else setState({ loading: false, userId: null, email: null, isAdmin: false });
    });

    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [loadRole]);

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    if (!supabase) return 'Supabase 미연결';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  return { ...state, signIn, signOut };
}
