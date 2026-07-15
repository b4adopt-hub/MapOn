import { useEffect, useState } from 'react';
import { supabaseReady } from '../lib/supabase';
import { useAuth } from './useAuth';
import {
  fetchMembers, fetchLookups, fetchWatches, fetchStats,
  updateMember, acknowledgeWatch,
  fetchExperts, reviewExpert, getDocUrl,
  MemberRow, LookupRow, WatchRow, Stats, ExpertAdminRow,
} from './adminData';
import EtlTab, { expectedEumMonth, fetchLoadedMonths } from './etl/EtlTab';
import './admin.css';

type Tab = 'dashboard' | 'members' | 'experts' | 'lookups' | 'ordinance' | 'etl';

export default function AdminApp() {
  const auth = useAuth();

  if (!supabaseReady) {
    return <Centered>Supabase가 연결되지 않았습니다. 환경변수를 확인하세요.</Centered>;
  }
  if (auth.loading) return <Centered>확인 중…</Centered>;
  if (!auth.userId) return <LoginGate signIn={auth.signIn} />;
  if (!auth.isAdmin) {
    return (
      <Centered>
        <div className="adm-denied">
          <h2>접근 권한 없음</h2>
          <p>이 페이지는 관리자만 이용할 수 있습니다.</p>
          <button className="adm-btn" onClick={auth.signOut}>로그아웃</button>
        </div>
      </Centered>
    );
  }
  return <AdminShell email={auth.email} onSignOut={auth.signOut} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="adm-center">{children}</div>;
}

function LoginGate({ signIn }: { signIn: (e: string, p: string) => Promise<string | null> }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    const e = await signIn(email.trim(), pw);
    if (e) setErr(e === 'Invalid login credentials' ? '이메일 또는 비밀번호가 올바르지 않습니다.' : e);
    setBusy(false);
  }

  return (
    <div className="adm-center">
      <div className="adm-login">
        <div className="adm-login-brand">맵땅 <span>관리자</span></div>
        <input className="adm-input" type="email" placeholder="이메일" value={email}
          onChange={e => setEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
        <input className="adm-input" type="password" placeholder="비밀번호" value={pw}
          onChange={e => setPw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
        {err && <div className="adm-err">{err}</div>}
        <button className="adm-btn primary" onClick={submit} disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button>
        <p className="adm-note">관리자 계정으로만 로그인할 수 있습니다.</p>
      </div>
    </div>
  );
}

function AdminShell({ email, onSignOut }: { email: string | null; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [etlStale, setEtlStale] = useState(false);
  useEffect(() => {
    fetchLoadedMonths()
      .then(({ permitted, zoning }) => {
        const exp = expectedEumMonth();
        setEtlStale(!permitted || permitted < exp || !zoning || zoning < exp);
      })
      .catch(() => setEtlStale(false));
  }, [tab]);
  return (
    <div className="adm-app">
      <aside className="adm-nav">
        <div className="adm-nav-brand">맵땅 <span>관리자</span></div>
        <nav>
          <button className={tab === 'dashboard' ? 'on' : ''} onClick={() => setTab('dashboard')}>대시보드</button>
          <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')}>회원 관리</button>
          <button className={tab === 'experts' ? 'on' : ''} onClick={() => setTab('experts')}>전문가 승인</button>
          <button className={tab === 'lookups' ? 'on' : ''} onClick={() => setTab('lookups')}>매물분석 기록</button>
          <button className={tab === 'ordinance' ? 'on' : ''} onClick={() => setTab('ordinance')}>조례 변경</button>
          <button className={tab === 'etl' ? 'on' : ''} onClick={() => setTab('etl')}>
            데이터 적재{etlStale && <span className="adm-nav-dot" title="신규 월 파일 적재 필요" />}
          </button>
        </nav>
        <div className="adm-nav-foot">
          <div className="adm-email">{email}</div>
          <button className="adm-btn ghost" onClick={onSignOut}>로그아웃</button>
        </div>
      </aside>
      <main className="adm-main">
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'members' && <MembersTab />}
        {tab === 'experts' && <ExpertsTab />}
        {tab === 'lookups' && <LookupsTab />}
        {tab === 'ordinance' && <OrdinanceTab />}
        {tab === 'etl' && <EtlTab />}
      </main>
    </div>
  );
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = () => {
    setLoading(true); setErr(null);
    fn().then(setData).catch(e => setErr(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  return { data, err, loading, reload };
}

function DashboardTab() {
  const { data, err, loading } = useAsync<Stats>(fetchStats, []);
  if (loading) return <Panel title="대시보드"><p className="adm-muted">불러오는 중…</p></Panel>;
  if (err) return <Panel title="대시보드"><div className="adm-err">{err}</div></Panel>;
  const s = data!;
  const maxDaily = Math.max(1, ...s.dailyLookups.map(d => d.n));
  return (
    <Panel title="대시보드">
      <div className="adm-cards">
        <Card label="총 회원" value={s.totalMembers} />
        <Card label="총 조회" value={s.totalLookups} />
        <Card label="최근 7일 조회" value={s.lookups7d} />
        <Card label="조례 변경 알림" value={s.changeAlerts} alert={s.changeAlerts > 0} />
      </div>

      <div className="adm-grid2">
        <div className="adm-box">
          <h3>지역별 조회 (최근 30일)</h3>
          {s.topRegions.length === 0 ? <p className="adm-muted">데이터 없음</p> :
            s.topRegions.map(r => <BarRow key={r.sido} label={r.sido} n={r.n} max={s.topRegions[0].n} />)}
        </div>
        <div className="adm-box">
          <h3>용도지역별 조회 (최근 30일)</h3>
          {s.topZones.length === 0 ? <p className="adm-muted">데이터 없음</p> :
            s.topZones.map(z => <BarRow key={z.zone} label={z.zone} n={z.n} max={s.topZones[0].n} />)}
        </div>
      </div>

      <div className="adm-box">
        <h3>일별 조회 추이 (최근 30일)</h3>
        {s.dailyLookups.length === 0 ? <p className="adm-muted">데이터 없음</p> :
          <div className="adm-spark">
            {s.dailyLookups.map(d => (
              <div key={d.day} className="adm-spark-bar" title={`${d.day}: ${d.n}`}
                style={{ height: `${Math.round((d.n / maxDaily) * 100)}%` }} />
            ))}
          </div>}
      </div>
    </Panel>
  );
}

function MembersTab() {
  const { data, err, loading, reload } = useAsync<MemberRow[]>(fetchMembers, []);
  async function change(id: string, patch: Partial<MemberRow>) {
    const e = await updateMember(id, patch);
    if (e) alert('변경 실패: ' + e); else reload();
  }
  return (
    <Panel title="회원 관리">
      {loading ? <p className="adm-muted">불러오는 중…</p> :
       err ? <div className="adm-err">{err}</div> :
       (data!.length === 0 ? <p className="adm-muted">회원이 없습니다. 회원가입 기능 연결 후 표시됩니다.</p> :
        <table className="adm-table">
          <thead><tr><th>이메일</th><th>이름</th><th>역할</th><th>요금제</th><th>상태</th><th>가입일</th></tr></thead>
          <tbody>
            {data!.map(m => (
              <tr key={m.id}>
                <td>{m.email ?? '-'}</td>
                <td>{m.display_name ?? '-'}</td>
                <td>
                  <select value={m.role} onChange={e => change(m.id, { role: e.target.value })}>
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>
                  <select value={m.plan} onChange={e => change(m.id, { plan: e.target.value })}>
                    <option value="free">free</option>
                    <option value="pro">pro</option>
                    <option value="business">business</option>
                  </select>
                </td>
                <td>
                  <select value={m.status} onChange={e => change(m.id, { status: e.target.value })}>
                    <option value="active">active</option>
                    <option value="suspended">suspended</option>
                  </select>
                </td>
                <td>{m.created_at?.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>)}
    </Panel>
  );
}

const EXPERT_TYPE_LABEL: Record<string, string> = {
  realtor: '공인중개사', legal: '법무사', architect: '건축사', appraiser: '감정평가사',
  auction: '경매 전문가', field: '임장 대행', civil: '토목·개발행위', other: '기타',
};
const EXPERT_STATUS_LABEL: Record<string, string> = {
  pending: '작성중', reviewing: '심사중', revision: '보완요청',
  approved: '승인', restricted: '제한', suspended: '정지', withdrawn: '탈퇴', docs_required: '서류필요',
};

function ExpertsTab() {
  const { data, err, loading, reload } = useAsync<ExpertAdminRow[]>(fetchExperts, []);
  const [sel, setSel] = useState<ExpertAdminRow | null>(null);

  async function act(id: string, status: string) {
    let note: string | null = null;
    if (status === 'revision' || status === 'restricted' || status === 'suspended') {
      note = prompt('사유/메모를 입력하세요(전문가에게 표시):', '') ?? null;
    }
    const e = await reviewExpert(id, status, note);
    if (e) alert('처리 실패: ' + e); else { setSel(null); reload(); }
  }
  async function openDoc(path: string | null) {
    if (!path) { alert('파일 없음'); return; }
    const url = await getDocUrl(path);
    if (url) window.open(url, '_blank'); else alert('파일 열기 실패');
  }

  return (
    <Panel title="전문가 승인">
      {loading ? <p className="adm-muted">불러오는 중…</p> :
       err ? <div className="adm-err">{err}</div> :
       (data!.length === 0 ? <p className="adm-muted">전문가 신청이 없습니다.</p> :
        <table className="adm-table">
          <thead><tr><th>이름</th><th>유형</th><th>지역</th><th>사무소</th><th>상태</th><th>신청일</th><th></th></tr></thead>
          <tbody>
            {data!.map(x => (
              <tr key={x.id} className={x.status === 'reviewing' ? 'adm-row-alert' : ''}>
                <td>{x.name}</td>
                <td>{EXPERT_TYPE_LABEL[x.expert_type] ?? x.expert_type}</td>
                <td>{x.region ?? '-'}</td>
                <td>{x.office_name ?? '-'}</td>
                <td><span className={`adm-badge ${x.status === 'approved' ? 'ok' : x.status === 'reviewing' ? 'alert' : ''}`}>{EXPERT_STATUS_LABEL[x.status] ?? x.status}</span></td>
                <td className="adm-nowrap">{x.created_at?.slice(0, 10)}</td>
                <td><button className="adm-btn sm" onClick={() => setSel(x)}>상세</button></td>
              </tr>
            ))}
          </tbody>
        </table>)}

      {sel && (
        <div className="adm-modal-bg" onClick={() => setSel(null)}>
          <div className="adm-modal" onClick={e => e.stopPropagation()}>
            <h3>{sel.name} · {EXPERT_TYPE_LABEL[sel.expert_type] ?? sel.expert_type}</h3>
            <div className="adm-kv"><span>휴대폰</span><b>{sel.phone ?? '-'}</b></div>
            <div className="adm-kv"><span>활동지역</span><b>{sel.region ?? '-'}</b></div>
            <div className="adm-kv"><span>사무소명</span><b>{sel.office_name ?? '-'}</b></div>
            <div className="adm-kv"><span>대표자</span><b>{sel.rep_name ?? '-'}</b></div>
            <div className="adm-kv"><span>사업자번호</span><b>{sel.biz_no ?? '-'}</b></div>
            <div className="adm-kv"><span>자격/등록번호</span><b>{sel.license_no ?? '-'}</b></div>
            <div className="adm-kv"><span>사무소주소</span><b>{sel.office_addr ?? '-'}</b></div>
            <div className="adm-kv"><span>활동분야</span><b>{sel.fields?.join(', ') ?? '-'}</b></div>
            {sel.intro && <div className="adm-kv"><span>소개</span><b>{sel.intro}</b></div>}
            <div className="adm-doc-row">
              <button className="adm-btn sm" onClick={() => openDoc(sel.license_file)} disabled={!sel.license_file}>자격증 보기</button>
              <button className="adm-btn sm" onClick={() => openDoc(sel.biz_file)} disabled={!sel.biz_file}>사업자등록증 보기</button>
            </div>
            {sel.review_note && <div className="adm-err" style={{ marginTop: 10 }}>이전 메모: {sel.review_note}</div>}
            <div className="adm-modal-actions">
              <button className="adm-btn primary" onClick={() => act(sel.id, 'approved')}>승인</button>
              <button className="adm-btn" onClick={() => act(sel.id, 'revision')}>보완 요청</button>
              <button className="adm-btn" onClick={() => act(sel.id, 'suspended')}>정지</button>
              <button className="adm-btn ghost" onClick={() => setSel(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function LookupsTab() {
  const { data, err, loading } = useAsync<LookupRow[]>(() => fetchLookups(200), []);
  return (
    <Panel title="매물분석 기록">
      {loading ? <p className="adm-muted">불러오는 중…</p> :
       err ? <div className="adm-err">{err}</div> :
       (data!.length === 0 ? <p className="adm-muted">조회 기록이 없습니다. 조회 로깅 연결 후 쌓입니다.</p> :
        <table className="adm-table">
          <thead><tr><th>일시</th><th>주소</th><th>지역</th><th>용도지역</th><th>지목</th><th>면적</th><th>도로</th><th>목적</th></tr></thead>
          <tbody>
            {data!.map(r => (
              <tr key={r.id}>
                <td className="adm-nowrap">{r.created_at?.slice(5, 16).replace('T', ' ')}</td>
                <td>{r.address ?? r.pnu ?? '-'}</td>
                <td>{r.sido ?? '-'}</td>
                <td>{r.primary_use_zone ?? '-'}</td>
                <td>{r.jimok ?? '-'}</td>
                <td>{r.area_sqm != null ? `${Math.round(r.area_sqm).toLocaleString()}㎡` : '-'}</td>
                <td>{r.road_ownership ?? r.road_status ?? '-'}</td>
                <td>{r.purposes?.join(', ') ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>)}
    </Panel>
  );
}

function OrdinanceTab() {
  const { data, err, loading, reload } = useAsync<WatchRow[]>(fetchWatches, []);
  async function ack(w: WatchRow) {
    const d = prompt(`${w.sgg_name} ${w.law_name}\n새 시행일(YYYY-MM-DD), 없으면 비워두세요:`, w.known_effective_date ?? '');
    if (d === null) return;
    const e = await acknowledgeWatch(w.id, d.trim() || null);
    if (e) alert('처리 실패: ' + e); else reload();
  }
  return (
    <Panel title="조례 변경 감시">
      {loading ? <p className="adm-muted">불러오는 중…</p> :
       err ? <div className="adm-err">{err}</div> :
        <table className="adm-table">
          <thead><tr><th>지자체</th><th>조례</th><th>기준 시행일</th><th>마지막 확인</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {data!.map(w => (
              <tr key={w.id} className={w.change_detected ? 'adm-row-alert' : ''}>
                <td>{w.sgg_name ?? '-'}</td>
                <td>{w.law_name}</td>
                <td>{w.known_effective_date ?? '미설정'}</td>
                <td className="adm-nowrap">{w.last_checked?.slice(0, 10) ?? '-'}</td>
                <td>{w.change_detected ? <span className="adm-badge alert">변경 감지</span> : <span className="adm-badge ok">정상</span>}</td>
                <td><button className="adm-btn sm" onClick={() => ack(w)}>확인 처리</button></td>
              </tr>
            ))}
          </tbody>
        </table>}
      <p className="adm-muted adm-small">매일 새벽 자동 점검됩니다. '변경 감지'는 조례 시행일이 바뀐 항목입니다. 본문 확인 후 수치를 갱신하고 '확인 처리'로 기준일을 업데이트하세요.</p>
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="adm-panel"><h1>{title}</h1>{children}</div>;
}
function Card({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return <div className={`adm-card ${alert ? 'alert' : ''}`}><div className="adm-card-v">{value.toLocaleString()}</div><div className="adm-card-l">{label}</div></div>;
}
function BarRow({ label, n, max }: { label: string; n: number; max: number }) {
  return (
    <div className="adm-bar">
      <span className="adm-bar-l">{label}</span>
      <span className="adm-bar-track"><span className="adm-bar-fill" style={{ width: `${Math.round((n / max) * 100)}%` }} /></span>
      <span className="adm-bar-n">{n}</span>
    </div>
  );
}
