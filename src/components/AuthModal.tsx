import { useState } from 'react';

interface Props {
  onClose: () => void;
  signIn: (e: string, p: string) => Promise<string | null>;
  signUp: (e: string, p: string, n: string) => Promise<string | null>;
}

export default function AuthModal({ onClose, signIn, signUp }: Props) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signupDone, setSignupDone] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true); setErr(null);
    if (mode === 'login') {
      const e = await signIn(email.trim(), pw);
      if (e) setErr(e === 'Invalid login credentials' ? '이메일 또는 비밀번호가 올바르지 않습니다.' : e);
      else { onClose(); return; }
    } else {
      if (name.trim().length < 1) { setErr('이름을 입력하세요.'); setBusy(false); return; }
      if (pw.length < 6) { setErr('비밀번호는 6자 이상이어야 합니다.'); setBusy(false); return; }
      const e = await signUp(email.trim(), pw, name.trim());
      if (e) {
        setErr(e.includes('already registered') || e.includes('already been registered')
          ? '이미 가입된 이메일입니다. 로그인하거나 비밀번호 찾기를 이용하세요.' : e);
      } else {
        setSignupDone(true);
      }
    }
    setBusy(false);
  }

  function switchMode(m: 'login' | 'signup') {
    setMode(m); setErr(null); setSignupDone(false);
  }

  return (
    <div className="mp-modal-bg" onClick={onClose}>
      <div className="mp-modal" onClick={e => e.stopPropagation()}>
        <div className="mp-modal-tabs">
          <button className={mode === 'login' ? 'on' : ''} onClick={() => switchMode('login')}>로그인</button>
          <button className={mode === 'signup' ? 'on' : ''} onClick={() => switchMode('signup')}>회원가입</button>
        </div>

        {signupDone ? (
          <>
            <div className="mp-modal-msg">
              가입이 접수되었습니다. <b>{email.trim()}</b>으로 보낸 확인 메일의 링크를 눌러 인증을 완료한 뒤 로그인하세요.
            </div>
            <button className="mp-modal-btn" onClick={() => switchMode('login')}>로그인하러 가기</button>
            <button className="mp-link-btn" style={{ margin: '4px auto 0' }} onClick={onClose}>닫기</button>
          </>
        ) : (
          <>
            {mode === 'signup' && (
              <input className="mp-input" placeholder="이름" value={name}
                onChange={e => setName(e.target.value)} />
            )}
            <input className="mp-input" type="email" placeholder="이메일" value={email}
              onChange={e => setEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
            <input className="mp-input" type="password" placeholder="비밀번호 (6자 이상)" value={pw}
              onChange={e => setPw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />

            {err && <div className="mp-modal-err">{err}</div>}

            <button className="mp-modal-btn" onClick={submit} disabled={busy}>
              {busy ? '처리 중…' : (mode === 'login' ? '로그인' : '가입하기')}
            </button>

            <div className="mp-modal-foot">
              전문가(중개사·법무사·건축사 등)로 활동하시나요?{' '}
              <a href="/expert">전문가 가입 신청 →</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
