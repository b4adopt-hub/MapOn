# -*- coding: utf-8 -*-
"""eum.go.kr 열린데이터에서 토지이용규제 법령정보(dataCd=006)·행위제한정보(dataCd=007)
최신 월 파일을 내려받는다. 링크를 못 찾으면 페이지 구조를 로그로 덤프해 실측 보정을 돕는다.
"""
import argparse, os, re, sys, zipfile
import requests

BASE = 'https://www.eum.go.kr'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Referer': BASE}
NAME = {'006': '법령정보', '007': '행위제한정보'}

def dump_debug(html: str, data_cd: str):
    print(f'--- [debug] dataCd={data_cd} 페이지 내 다운로드 관련 요소 ---')
    pat = re.compile(r'.{0,120}(?:down|Down|DOWN|다운|file|File|\.zip|\.xlsx|\.csv|onclick)[^\n]{0,160}')
    seen = set()
    n = 0
    for m in pat.finditer(html):
        line = m.group(0).strip().replace('\t', ' ')
        key = line[:80]
        if key in seen:
            continue
        seen.add(key)
        print('[debug]', line[:280])
        n += 1
        if n >= 50:
            print('[debug] ... (50개 초과 생략)')
            break
    if n == 0:
        print('[debug] 관련 문자열 없음. 응답 앞 1500자:')
        print(html[:1500])
    print('--- [debug] 끝 ---')

def latest_link(data_cd: str, sess: requests.Session):
    url = f'{BASE}/web/op/sv/svItemDet.jsp?dataCd={data_cd}&dataTypeCd=CSV&currentPageNo=1&selectType=subject'
    r = sess.get(url, headers=UA, timeout=60)
    print(f'[fetch_eum] dataCd={data_cd}: HTTP {r.status_code}, {len(r.text)}자')
    r.raise_for_status()
    html = r.text
    cands = []
    # 1) href/src 안의 다운로드성 경로
    cands += re.findall(r"(?:href|src)=[\"']([^\"']*(?:fileDown|FileDown|download|Download)[^\"']*)[\"']", html)
    # 2) 직접 파일 링크
    cands += re.findall(r"(?:href|src)=[\"']([^\"']+\.(?:zip|xlsx|csv))[\"']", html, re.I)
    # 3) onclick 함수 호출 인자 (fn_fileDown, fnFileDown, goDown, fileDownload 등)
    for fn, args in re.findall(r"onclick=[\"'][^\"']*?([A-Za-z_]*[Dd]own[A-Za-z_]*)\(([^)]*)\)", html):
        print(f'[fetch_eum] onclick 후보: {fn}({args})')
    if not cands:
        dump_debug(html, data_cd)
        sys.exit(f'[fetch_eum] dataCd={data_cd}: 다운로드 링크를 찾지 못함. 위 debug 출력을 근거로 보정 필요.')
    link = cands[0]
    if link.startswith('/'):
        link = BASE + link
    elif not link.startswith('http'):
        link = f'{BASE}/web/op/sv/{link}'
    m = re.search(r'20[0-9]{6}', html)
    month = m.group(0)[:6] if m else ''
    print(f'[fetch_eum] dataCd={data_cd}: 선택 링크 {link} (month후보={month})')
    return link, month

def download(url: str, out_dir: str, tag: str, sess: requests.Session) -> str:
    r = sess.get(url, headers=UA, timeout=600, stream=True)
    r.raise_for_status()
    cd = r.headers.get('content-disposition', '')
    m = re.search(r'filename\*?=(?:UTF-8\'\')?\"?([^\";]+)', cd)
    fname = requests.utils.unquote(m.group(1)) if m else f'{tag}.bin'
    path = os.path.join(out_dir, fname)
    with open(path, 'wb') as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
    print(f'[fetch_eum] {tag}: 수신 {fname} ({os.path.getsize(path):,} bytes, content-type={r.headers.get("content-type")})')
    if path.lower().endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            z.extractall(out_dir)
            xl = [n for n in z.namelist() if n.lower().endswith('.xlsx')]
        if xl:
            path = os.path.join(out_dir, xl[0])
    if not path.lower().endswith('.xlsx'):
        sys.exit(f'[fetch_eum] {tag}: xlsx가 아닌 응답({fname}).')
    if tag not in os.path.basename(path):
        std = os.path.join(out_dir, f'토지이용규제_{tag}_전국.xlsx')
        os.replace(path, std)
        path = std
    print(f'[fetch_eum] {tag}: {path}')
    return path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    sess = requests.Session()
    months = set()
    for cd in ('006', '007'):
        link, month = latest_link(cd, sess)
        if month:
            months.add(month)
        download(link, a.out, NAME[cd], sess)
    if months:
        print(f'[fetch_eum] month={sorted(months)[-1]}')

if __name__ == '__main__':
    main()
