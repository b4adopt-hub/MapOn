# -*- coding: utf-8 -*-
"""eum.go.kr 열린데이터: 법령정보(006)·행위제한정보(007) 최신 월 파일 다운로드.
해외 IP 간헐 차단에 대비해 연결 재시도를 내장한다.

다운로드 메커니즘을 확정하기 위해:
 - 페이지 인라인 <script> + 외부 .js 를 모두 뒤져 dataDownload 계열 함수 정의를 찾고 전문을 로그로 남긴다.
 - 정의에서 URL·HTTP 메서드(GET/POST)·파라미터명을 추출한다.
 - GET 후보와 POST 후보를 모두 시도하고, 실패 시 form action 후보까지 시도한다.
"""
import argparse, os, re, sys, time, zipfile
import requests

BASE = 'https://www.eum.go.kr'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Referer': BASE + '/web/op/sv/svItemDet.jsp'}
NAME = {'006': '법령정보', '007': '행위제한정보'}
MIN_SIZE = {'006': 1_000_000, '007': 10_000_000}


def get(sess, url, attempts=3, timeout=40, **kw):
    last = None
    for i in range(1, attempts + 1):
        try:
            return sess.get(url, headers=UA, timeout=timeout, **kw)
        except requests.exceptions.RequestException as e:
            last = e
            print(f'[fetch_eum] 연결 실패 {i}/{attempts}: {type(e).__name__} — {url[:80]}')
            time.sleep(8 * i)
    raise last


def collect_scripts(sess, html):
    """페이지 인라인 스크립트 + 외부 js 본문을 모은다."""
    sources = []
    # 인라인 <script>...</script>
    for m in re.finditer(r'<script[^>]*>(.*?)</script>', html, re.S | re.I):
        if m.group(1).strip():
            sources.append(('inline', m.group(1)))
    # 외부 js
    for js in re.findall(r'<script[^>]+src=[\"\']([^\"\']+)[\"\']', html, re.I):
        u = js if js.startswith('http') else BASE + (js if js.startswith('/') else '/' + js)
        if not u.lower().endswith('.js') and '.js?' not in u.lower():
            continue
        try:
            r = get(sess, u, attempts=1, timeout=30)
            if r.ok:
                sources.append((u, r.text))
        except requests.RequestException:
            pass
    return sources


def analyze_download(sess, html):
    """dataDownload 계열 함수 정의를 찾아 (url, method, param) 후보를 만든다."""
    sources = collect_scripts(sess, html)
    found = []
    fn_pat = re.compile(r'function\s+([A-Za-z_]*[Dd]own[A-Za-z_]*)\s*\(([^)]*)\)\s*\{(.*?)\n\s*\}', re.S)
    for origin, src in sources:
        for m in fn_pat.finditer(src):
            name, args, body = m.group(1), m.group(2), m.group(3)
            snippet = re.sub(r'\s+', ' ', body).strip()
            print(f'[fetch_eum] 함수 정의 발견 [{origin[:40]}] {name}({args}): {snippet[:500]}')
            found.append((name, args, body))
    # 폼 액션도 로그
    for m in re.finditer(r'<form[^>]+(?:name|id)=[\"\']?([^\"\'\s>]*[Dd]own[^\"\'\s>]*)[\"\']?[^>]*action=[\"\']([^\"\']+)[\"\']', html, re.I):
        print(f'[fetch_eum] form 발견: name={m.group(1)} action={m.group(2)}')
    # 함수 본문에서 URL·메서드 추출
    urls = []
    for name, args, body in found:
        for um in re.finditer(r'[\"\']([^\"\']*\.(?:do|jsp)[^\"\']*)[\"\']', body):
            u = um.group(1)
            method = 'POST' if re.search(r'\.(submit|post)\s*\(', body, re.I) or re.search(r"type\s*[:=]\s*[\"']post", body, re.I) else 'GET'
            params = re.findall(r'[?&]([A-Za-z_]+)=', u) or re.findall(r'name\s*[:=]\s*[\"\']([A-Za-z_]+)[\"\']', body)
            urls.append((u, method, params))
    return urls


def normalize(u):
    if u.startswith('http'):
        return u
    if u.startswith('/'):
        return BASE + u
    return f'{BASE}/web/op/sv/{u}'


def save_if_valid(r, out_dir, tag):
    if not r or not r.ok:
        return None
    cd = r.headers.get('content-disposition', '')
    ctype = r.headers.get('content-type', '')
    fname = ''
    m = re.search(r"filename\*=UTF-8''([^;]+)", cd)
    if m:
        fname = requests.utils.unquote(m.group(1))
    else:
        m = re.search(r'filename=\"?([^\";]+)', cd)
        if m:
            rawb = m.group(1).encode('latin-1', 'ignore')
            for enc in ('utf-8', 'euc-kr', 'cp949'):
                try:
                    fname = rawb.decode(enc); break
                except UnicodeDecodeError:
                    continue
    if not fname:
        fname = f'{tag}.bin'
    path = os.path.join(out_dir, fname)
    size = 0
    with open(path, 'wb') as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk); size += len(chunk)
    print(f'[fetch_eum] {tag}: {fname} ({size:,} bytes, {ctype})')
    if size < MIN_SIZE[[k for k, v in NAME.items() if v == tag][0]]:
        print(f'[fetch_eum] {tag}: 크기 미달 — 데이터 파일 아님')
        os.remove(path)
        return None
    if path.lower().endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            z.extractall(out_dir)
            xl = [n for n in z.namelist() if n.lower().endswith('.xlsx')]
        if xl:
            path = os.path.join(out_dir, xl[0])
    if not path.lower().endswith('.xlsx'):
        print(f'[fetch_eum] {tag}: xlsx 아님({fname})')
        return None
    std = os.path.join(out_dir, f'토지이용규제_{tag}_전국.xlsx')
    if os.path.abspath(path) != os.path.abspath(std):
        os.replace(path, std)
    return std


def attempt(sess, url, method, params, seq, out_dir, tag):
    """GET/POST 한 번 시도."""
    body = {p: seq for p in params} if params else {'seq': seq}
    try:
        if method == 'POST':
            r = sess.post(url, data=body, headers=UA, timeout=900, stream=True)
        else:
            sep = '&' if '?' in url else '?'
            full = url if ('=' in url and url.rstrip().endswith('=')) else url + sep + '&'.join(f'{p}={seq}' for p in (params or ['seq']))
            if url.rstrip().endswith('='):
                full = url + seq
            r = sess.get(full, headers=UA, timeout=900, stream=True)
    except requests.RequestException as e:
        print(f'[fetch_eum] {tag}: {method} {url[:70]} -> {type(e).__name__}')
        return None
    if not r.ok:
        print(f'[fetch_eum] {tag}: {method} {url[:70]} -> HTTP {r.status_code}')
        return None
    return save_if_valid(r, out_dir, tag)


def fetch_one(sess, data_cd, out_dir):
    tag = NAME[data_cd]
    url = f'{BASE}/web/op/sv/svItemDet.jsp?dataCd={data_cd}&dataTypeCd=CSV&currentPageNo=1&selectType=subject'
    r = get(sess, url)
    r.raise_for_status()
    html = r.text
    seqs = re.findall(r"dataDownload\('?(\d+)'?\)", html)
    if not seqs:
        sys.exit(f'[fetch_eum] dataCd={data_cd}: dataDownload 호출을 찾지 못함')
    seq = seqs[0]
    print(f'[fetch_eum] dataCd={data_cd}: 최신 seq={seq} (후보 {len(seqs)}개)')
    m = re.search(r'20[0-9]{6}', html)
    month = m.group(0)[:6] if m else ''

    # 함수 정의 분석 → 우선 후보
    discovered = analyze_download(sess, html)
    tried = set()
    for u, method, params in discovered:
        nu = normalize(u)
        key = (nu, method)
        if key in tried:
            continue
        tried.add(key)
        print(f'[fetch_eum] 시도(정의추출): {method} {nu} params={params}')
        path = attempt(sess, nu, method, params, seq, out_dir, tag)
        if path:
            print(f'[fetch_eum] {tag}: 확정 {path}')
            return month

    # 폴백: 관행 후보 (GET/POST 양쪽)
    fallback = [
        '/web/op/sv/dataDownload.do', '/web/op/sv/dataDownload.jsp',
        '/web/op/sv/svDataDownload.do', '/web/op/sv/svDataDownload.jsp',
        '/web/op/sv/fileDownload.do', '/web/op/mp/mpFileDown.do',
    ]
    for path_u in fallback:
        for method in ('POST', 'GET'):
            for params in (['seq'], ['fileSeq'], ['dataSeq']):
                key = (BASE + path_u, method, tuple(params))
                if key in tried:
                    continue
                tried.add(key)
                path = attempt(sess, BASE + path_u, method, params, seq, out_dir, tag)
                if path:
                    print(f'[fetch_eum] {tag}: 확정(폴백) {path}')
                    return month
    sys.exit(f'[fetch_eum] dataCd={data_cd}: 모든 후보 실패. 위 "함수 정의 발견" 로그를 근거로 확정 보정 필요.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    sess = requests.Session()
    months = set()
    for cd in ('006', '007'):
        mo = fetch_one(sess, cd, a.out)
        if mo:
            months.add(mo)
    if months:
        print(f'[fetch_eum] month={sorted(months)[-1]}')


if __name__ == '__main__':
    main()
