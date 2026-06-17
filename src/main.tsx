import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

// 경로별 진입점. 각 앱은 lazy로 분리돼 서로의 번들에 섞이지 않는다.
const path = window.location.pathname.replace(/\/+$/, '');
const route = path.startsWith('/admin') ? 'admin' : path.startsWith('/expert') ? 'expert' : 'main';

const App = React.lazy(() => import('./App'));
const AdminApp = React.lazy(() => import('./admin/AdminApp'));
const ExpertApp = React.lazy(() => import('./expert/ExpertApp'));

const view = route === 'admin' ? <AdminApp /> : route === 'expert' ? <ExpertApp /> : <App />;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: '#6b7785' }}>불러오는 중…</div>}>
      {view}
    </Suspense>
  </React.StrictMode>,
);
