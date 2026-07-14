# -*- coding: utf-8 -*-
"""eum.go.kr 열린데이터에서 토지이용규제 법령정보(dataCd=006)·행위제한정보(dataCd=007)
최신 월 파일을 내려받는다. 페이지 구조가 바뀌면 명확한 오류로 실패하며,
그 경우 workflow_dispatch의 release 모드(릴리스 자산 업로드)로 폴백한다.
"""
import argparse, os, re, sys, zipfile
import requests

BASE = 'https://www.eum.go.kr'
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'}
NAME = {'006': '법령정보', '007': '행위제한정보'}

def latest_link(data_cd: str, sess: requests.Session):
    url = f'{BASE}/web/op/sv/svItemDet.jsp?dataCd={data_cd}&dataTypeCd=CSV&currentPageNo=1&selectType=subject'
    r = sess.get(url, headers=UA, timeout=60)
    r.raise_for_status()
    html = r.text
    cands = re.findall(r"(?:href|src)=[\"']([^\"']*(?:fileDown|FileDown|download)[^\"']*)[\"']", html)
    cands += [f"{BASE}/web/op/sv/svFileDown.jsp?fileSeq={m}" for m in re.findall(r"fn_fileDown\('?(\d+)'?\)", html)]
    if not cands:
        sys.exit(f'[fetch_eum] dataCd={data_cd}: 다운로드 링크를 찾지 못함. 페이지 구조 변경 추정 — release 모드로 폴백하십시오.')
    link = cands[0]
    if link.startswith('/'):
        link = BASE + link
    m = re.search(r'20[0-9]{6}', html)
    month = m.group(0)[:6] if m else ''
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
    if path.lower().endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            z.extractall(out_dir)
            xl = [n for n in z.namelist() if n.lower().endswith('.xlsx')]
        if xl:
            path = os.path.join(out_dir, xl[0])
    if not path.lower().endswith('.xlsx'):
        sys.exit(f'[fetch_eum] {tag}: xlsx가 아닌 응답({fname}). 세션 요구 가능 — release 모드로 폴백하십시오.')
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
