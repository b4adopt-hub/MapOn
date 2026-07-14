# -*- coding: utf-8 -*-
"""eum.go.kr 열린데이터: 법령정보(006)·행위제한정보(007) 최신 월 파일 다운로드.
해외 IP 간헐 차단에 대비해 연결 재시도를 내장한다.
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
            time.sleep(10 * i)
    raise last

def find_template(sess, html):
    sources = [html]
    for js in re.findall(r"src=[\"']([^\"']+\.js[^\"']*)[\"']", html):
        u = js if js.startswith('http') else BASE + (js if js.startswith('/') else '/' + js)
        try:
            r = get(sess, u, attempts=1, timeout=30)
            if r.ok:
                sources.append(r.text)
        except requests.RequestException:
            pass
    for src in sources:
        m = re.search(r'function\s+dataDownload\s*\(([^)]*)\)\s*\{(.*?)\}', src, re.S)
        if m:
            body = m.group(2)
            print('[fetch_eum] dataDownload 정의 발견:', re.sub(r'\s+', ' ', body)[:400])
            um = re.search(r"[\"']([^\"']*\.jsp[^\"']*)[\"']", body)
            if um:
                return um.group(1), body
            return None, body
    return None, None

def try_download(sess, url, out_dir, tag):
    try:
        r = get(sess, url, attempts=2, timeout=900, stream=True)
    except requests.RequestException as e:
        print(f'[fetch_eum] {tag}: {url} -> 연결 실패 {type(e).__name__}')
        return None
    if not r.ok:
        print(f'[fetch_eum] {tag}: {url} -> HTTP {r.status_code}')
        return None
    cd = r.headers.get('content-disposition', '')
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
                    fname = rawb.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
    if not fname:
        fname = f'{tag}.bin'
    path = os.path.join(out_dir, fname)
    size = 0
    with open(path, 'wb') as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
            size += len(chunk)
    print(f'[fetch_eum] {tag}: {url} -> {fname} ({size:,} bytes, {r.headers.get("content-type")})')
    if size < MIN_SIZE[[k for k, v in NAME.items() if v == tag][0]]:
        print(f'[fetch_eum] {tag}: 크기 미달 — 데이터 파일 아님, 다음 후보 시도')
        os.remove(path)
        return None
    if path.lower().endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            z.extractall(out_dir)
            xl = [n for n in z.namelist() if n.lower().endswith('.xlsx')]
        if xl:
            path = os.path.join(out_dir, xl[0])
    if not path.lower().endswith('.xlsx'):
        print(f'[fetch_eum] {tag}: xlsx 아님({fname}) — 다음 후보 시도')
        return None
    std = os.path.join(out_dir, f'토지이용규제_{tag}_전국.xlsx')
    if os.path.abspath(path) != os.path.abspath(std):
        os.replace(path, std)
    return std

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

    tmpl, body = find_template(sess, html)
    cands = []
    if tmpl:
        t = tmpl if tmpl.startswith('http') else BASE + (tmpl if tmpl.startswith('/') else '/web/op/sv/' + tmpl)
        sep = '&' if '?' in t else '?'
        pnames = re.findall(r'[?&]([A-Za-z_]+)=', t) or ['seq', 'fileSeq', 'dataSeq', 'idx']
        if '=' in t and t.rstrip().endswith('='):
            cands.append(t + seq)
        else:
            for p in pnames:
                cands.append(f'{t}{sep}{p}={seq}')
    cands += [
        f'{BASE}/web/op/sv/dataDownload.jsp?seq={seq}',
        f'{BASE}/web/op/sv/dataDownload.jsp?fileSeq={seq}',
        f'{BASE}/web/op/sv/svDataDownload.jsp?seq={seq}',
        f'{BASE}/web/op/sv/svDataDownload.jsp?fileSeq={seq}',
        f'{BASE}/web/op/sv/svItemDownload.jsp?seq={seq}',
    ]
    seen = set()
    for u in cands:
        if u in seen:
            continue
        seen.add(u)
        path = try_download(sess, u, out_dir, tag)
        if path:
            print(f'[fetch_eum] {tag}: 확정 {path}')
            return month
    sys.exit(f'[fetch_eum] dataCd={data_cd}: 모든 후보 URL 실패. 위 로그(dataDownload 정의)를 근거로 추가 보정 필요.')

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
