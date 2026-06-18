import { useEffect, useState } from 'react';
import { supabaseReady } from '../lib/supabase';
import { useAuth } from '../lib/useAuth';
import AuthModal from '../components/AuthModal';
import {
  EXPERT_TYPES, EXPERT_FIELDS, STATUS_LABEL,
  ExpertInput, getMyExpert, submitExpert, uploadDoc,
} from './expertData';
import './expert.css';

const EMPTY: ExpertInput = {
  expert_type: '', name: '', phone: '', region: '',
  office_name: '', rep_name: '', biz_no: '', license_no: '',
  office_addr: '', office_phone: '', fields: [], intro: '',
};

export default function ExpertApp() {
  const auth = useAuth();
  const [showAuth, setShowAuth] = useState(false);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<ExpertInput>(EMPTY);
  const [existing, setExisting] = useState<{ status: string; review_note: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (auth.loading) return;
    if (!auth.userId) { setLoading(false); return; }
    getMyExpert(auth.userId).then(row => {
      if (row) {
        setExisting({ status: row.status, review_note: row.review_note });
        setForm({
          expert_type: row.expert_type ?? '', name: row.name ?? '', phone: row.phone ?? '',
          region: row.region ?? '', office_name: row.office_name ?? '', rep_name: row.rep_name ?? '',
          biz_no: row.biz_no ?? '', license_no: row.license_no ?? '', office_addr: row.office_addr ?? '',
          office_phone: row.office_phone ?? '', fields: row.fields ?? [], intro: row.intro ?? '',
        });
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [auth.loading, auth.userId]);

  const set = (k: keyof ExpertInput, v: any) => setForm(f => ({ ...f, [k]: v }));
  const toggleField = (f: string) => setForm(s => ({ ...s, fields: s.fields.includes(f) ? s.fields.filter(x => x !== f) : [...s.fields, f] }));

  if (!supabaseReady) return <Center>Supabase가 연결되지 않았습니다.</Center>;
  if (auth.loading || loading) return <Center>불러오는 중…</Center>;

  if (!auth.userId) {
    return (
      <div className="exp-page">
        <Hero />
        <div className="exp-card exp-center-card">
          <p>전문가 신청은 먼저 로그인이 필요합니다.</p>
          <button className="exp-btn primary" onClick={() => setShowAuth(true)}>로그인 / 회원가입</button>
        </div>
        {showAuth && <AuthModal onClose={() => setShowAuth(false)} signIn={auth.signIn} signUp={auth.signUp} />}
      </div>
    );
  }

  if (existing && !done && ['reviewing', 'approved', 'restricted', 'suspended'].includes(existing.status)) {
    return (
      <div className="exp-page">
        <Hero />
        <div className="exp-card exp-center-card">
          <div className={`exp-status exp-status-${existing.status}`}>{STATUS_LABEL[existing.status] ?? existing.status}</div>
          {existing.status === 'reviewing' && <p>제출하신 전문가 신청을 관리자가 심사 중입니다. 승인되면 전문가 기능을 사용할 수 있습니다.</p>}
          {existing.status === 'approved' && <p>승인 완료된 전문가 계정입니다. (매물 분석 링크 생성 등 전문가 기능은 순차 오픈됩니다.)</p>}
          {existing.review_note && <div className="exp-note">관리자 메모: {existing.review_note}</div>}
          <button className="exp-btn" onClick={auth.signOut}>로그아웃</button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="exp-page">
        <Hero />
        <div className="exp-card exp-center-card">
          <div className="exp-status exp-status-reviewing">심사 접수됨</div>
          <p>전문가 신청이 접수되었습니다. 관리자 승인 후 전문가 기능을 사용할 수 있습니다. 보완이 필요하면 안내드립니다.</p>
          <a className="exp-btn" href="/">맵땅 메인으로</a>
        </div>
      </div>
    );
  }

  async function next() {
    setErr(null);
    if (step === 1) {
      if (!form.expert_type) return setErr('전문가 유형을 선택하세요.');
      if (!form.name.trim()) return setErr('이름을 입력하세요.');
      if (!form.phone.trim()) return setErr('휴대폰 번호를 입력하세요.');
    }
    setStep(s => s + 1);
  }

  async function submit() {
    setBusy(true); setErr(null);
    const e = await submitExpert(auth.userId!, form);
    if (e) { setErr(e); setBusy(false); return; }
    setBusy(false); setDone(true);
  }

  async function onFile(kind: 'license' | 'biz', file: File | null) {
    if (!file || !auth.userId) return;
    setBusy(true);
    const r = await uploadDoc(auth.userId, kind, file);
    setBusy(false);
    if (r.error) setErr('파일 업로드 실패: ' + r.error);
  }

  return (
    <div className="exp-page">
      <Hero />
      <div className="exp-steps">
        {['기본 정보', '자격·사업자', '활동 분야'].map((t, i) => (
          <div key={t} className={`exp-step ${step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''}`}>
            <span className="exp-step-n">{i + 1}</span>{t}
          </div>
        ))}
      </div>

      <div className="exp-card">
        {step === 1 && (
          <>
            <Field label="전문가 유형 *">
              <div className="exp-chips">
                {EXPERT_TYPES.map(t => (
                  <button key={t.v} className={`exp-chip ${form.expert_type === t.v ? 'on' : ''}`}
                    onClick={() => set('expert_type', t.v)}>{t.l}</button>
                ))}
              </div>
            </Field>
            <Field label="이름 *"><input className="exp-input" value={form.name} onChange={e => set('name', e.target.value)} /></Field>
            <Field label="휴대폰 *"><input className="exp-input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="010-0000-0000" /></Field>
            <Field label="활동지역"><input className="exp-input" value={form.region} onChange={e => set('region', e.target.value)} placeholder="예) 경기 가평·남양주" /></Field>
          </>
        )}

        {step === 2 && (
          <>
            <p className="exp-help">자격·사업자 정보는 관리자 심사에만 사용되며 외부에 공개되지 않습니다.</p>
            <Field label="사무소명/상호"><input className="exp-input" value={form.office_name} onChange={e => set('office_name', e.target.value)} /></Field>
            <Field label="대표자명"><input className="exp-input" value={form.rep_name} onChange={e => set('rep_name', e.target.value)} /></Field>
            <div className="exp-row">
              <Field label="사업자등록번호"><input className="exp-input" value={form.biz_no} onChange={e => set('biz_no', e.target.value)} /></Field>
              <Field label="자격/등록번호"><input className="exp-input" value={form.license_no} onChange={e => set('license_no', e.target.value)} placeholder="개업공인중개사 등록번호 등" /></Field>
            </div>
            <Field label="사무소 주소"><input className="exp-input" value={form.office_addr} onChange={e => set('office_addr', e.target.value)} /></Field>
            <Field label="대표 연락처"><input className="exp-input" value={form.office_phone} onChange={e => set('office_phone', e.target.value)} /></Field>
            <div className="exp-row">
              <Field label="자격증/등록증 파일"><input className="exp-file" type="file" onChange={e => onFile('license', e.target.files?.[0] ?? null)} /></Field>
              <Field label="사업자등록증 파일"><input className="exp-file" type="file" onChange={e => onFile('biz', e.target.files?.[0] ?? null)} /></Field>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <Field label="활동 분야 (복수 선택)">
              <div className="exp-chips">
                {EXPERT_FIELDS.map(f => (
                  <button key={f} className={`exp-chip ${form.fields.includes(f) ? 'on' : ''}`} onClick={() => toggleField(f)}>{f}</button>
                ))}
              </div>
            </Field>
            <Field label="전문가 소개 (선택)">
              <textarea className="exp-textarea" rows={3} value={form.intro} onChange={e => set('intro', e.target.value)}
                placeholder="활동 경력, 전문 분야를 간단히 적어주세요." />
            </Field>
            <div className="exp-agree">
              제출 시 입력하신 자격·사업자 정보가 사실임을 확인하며, 관리자 심사에 동의합니다. 허위 정보 확인 시 승인이 취소될 수 있습니다.
            </div>
          </>
        )}

        {err && <div className="exp-err">{err}</div>}

        <div className="exp-actions">
          {step > 1 && <button className="exp-btn" onClick={() => setStep(s => s - 1)} disabled={busy}>이전</button>}
          {step < 3 && <button className="exp-btn primary" onClick={next} disabled={busy}>다음</button>}
          {step === 3 && <button className="exp-btn primary" onClick={submit} disabled={busy}>{busy ? '제출 중…' : '심사 신청'}</button>}
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div className="exp-hero">
      <a href="/" className="exp-logo">맵<span>땅</span> <em>전문가센터</em></a>
      <h1>내 매물의 리스크를 공개하고, 신뢰 있는 상담으로 연결하세요.</h1>
      <p>맵땅 전문가센터는 중개업자·법무사·건축사·감정평가사·임장 전문가가 매물 분석 링크를 만들고 소비자 문의를 받을 수 있는 전문가용 플랫폼입니다.</p>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="exp-field"><label>{label}</label>{children}</div>;
}
function Center({ children }: { children: React.ReactNode }) {
  return <div className="exp-center">{children}</div>;
}
