import { supabase } from '../lib/supabase';

export interface MemberRow {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  plan: string;
  status: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface LookupRow {
  id: string;
  address: string | null;
  pnu: string | null;
  sido: string | null;
  primary_use_zone: string | null;
  jimok: string | null;
  area_sqm: number | null;
  road_status: string | null;
  road_ownership: string | null;
  purposes: string[] | null;
  created_at: string;
}

export interface WatchRow {
  id: string;
  sgg_name: string | null;
  law_name: string;
  known_effective_date: string | null;
  last_checked: string | null;
  change_detected: boolean;
  detected_at: string | null;
  note: string | null;
}

export interface Stats {
  totalMembers: number;
  totalLookups: number;
  lookups7d: number;
  changeAlerts: number;
  topRegions: { sido: string; n: number }[];
  topZones: { zone: string; n: number }[];
  dailyLookups: { day: string; n: number }[];
}

export async function fetchMembers(): Promise<MemberRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('id,email,display_name,role,plan,status,created_at,last_seen_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as MemberRow[];
}

export async function fetchLookups(limit = 200): Promise<LookupRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('lookup_logs')
    .select('id,address,pnu,sido,primary_use_zone,jimok,area_sqm,road_status,road_ownership,purposes,created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as LookupRow[];
}

export async function fetchWatches(): Promise<WatchRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('ordinance_watch')
    .select('id,sgg_name,law_name,known_effective_date,last_checked,change_detected,detected_at,note')
    .order('change_detected', { ascending: false })
    .order('sgg_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as WatchRow[];
}

export async function fetchStats(): Promise<Stats> {
  if (!supabase) {
    return { totalMembers: 0, totalLookups: 0, lookups7d: 0, changeAlerts: 0, topRegions: [], topZones: [], dailyLookups: [] };
  }
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();

  const [members, lookupsTotal, lookups7, alerts, recent] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('lookup_logs').select('id', { count: 'exact', head: true }),
    supabase.from('lookup_logs').select('id', { count: 'exact', head: true }).gte('created_at', since7),
    supabase.from('ordinance_watch').select('id', { count: 'exact', head: true }).eq('change_detected', true),
    supabase.from('lookup_logs').select('sido,primary_use_zone,created_at').gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()).limit(2000),
  ]);

  const rows = (recent.data ?? []) as { sido: string | null; primary_use_zone: string | null; created_at: string }[];

  const regionCount = new Map<string, number>();
  const zoneCount = new Map<string, number>();
  const dayCount = new Map<string, number>();
  for (const r of rows) {
    if (r.sido) regionCount.set(r.sido, (regionCount.get(r.sido) ?? 0) + 1);
    if (r.primary_use_zone) zoneCount.set(r.primary_use_zone, (zoneCount.get(r.primary_use_zone) ?? 0) + 1);
    const day = r.created_at.slice(0, 10);
    dayCount.set(day, (dayCount.get(day) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, key: 'sido' | 'zone') =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, n]) => key === 'sido' ? { sido: k, n } : { zone: k, n }) as any;

  const dailyLookups = [...dayCount.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, n]) => ({ day, n }));

  return {
    totalMembers: members.count ?? 0,
    totalLookups: lookupsTotal.count ?? 0,
    lookups7d: lookups7.count ?? 0,
    changeAlerts: alerts.count ?? 0,
    topRegions: top(regionCount, 'sido'),
    topZones: top(zoneCount, 'zone'),
    dailyLookups,
  };
}

/** 회원 역할/상태/요금제 변경(관리자 전용, RLS로 보호) */
export async function updateMember(id: string, patch: Partial<Pick<MemberRow, 'role' | 'plan' | 'status'>>): Promise<string | null> {
  if (!supabase) return 'Supabase 미연결';
  const { error } = await supabase.from('profiles').update(patch).eq('id', id);
  return error ? error.message : null;
}

/** 조례 변경 확인 처리: known_effective_date 갱신 + 플래그 해제 */
export async function acknowledgeWatch(id: string, newEffectiveDate: string | null): Promise<string | null> {
  if (!supabase) return 'Supabase 미연결';
  const patch: Record<string, unknown> = { change_detected: false, detected_at: null };
  if (newEffectiveDate) patch.known_effective_date = newEffectiveDate;
  const { error } = await supabase.from('ordinance_watch').update(patch).eq('id', id);
  return error ? error.message : null;
}
