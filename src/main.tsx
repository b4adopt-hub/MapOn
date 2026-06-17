import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

// 경로가 /admin 으로 시작하면 관리자 앱, 아니면 소비자 앱.
// 관리자 코드는 lazy로 분리돼 일반 소비자 번들에 섞이지 않는다.
const isAdmin = window.location.pathname.replace(/\/+$/, '').startsWith('/admin');

const App = React.lazy(() => import('./App'));
const AdminApp = React.lazy(() => import('./admin/AdminApp'));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: '#6b7785' }}>불러오는 중…</div>}>
      {isAdmin ? <AdminApp /> : <App />}
    </Suspense>
  </React.StrictMode>,
);
