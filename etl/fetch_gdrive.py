# -*- coding: utf-8 -*-
"""구글 드라이브 공유 링크에서 LURIS 파일 다운로드.
방식 A(링크 고정): 워크플로 Secrets/입력으로 파일 ID를 받아 내려받는다.

구글 드라이브 다운로드는 파일 크기·상태에 따라 경로가 갈린다:
 - 작은 파일: uc?export=download 로 바로 바이너리.
 - 큰 파일(대용량 스캔 불가): 확인 HTML을 먼저 주고, 그 안의 form(action/confirm/uuid)을
   그대로 POST 또는 GET 재요청해야 실제 파일이 온다.
두 엔드포인트(uc, usercontent)를 순차 시도하고, 응답이 실제 파일(비 HTML)인지 확인한다.

사용법:
  python fetch_gdrive.py --law-id <ID/링크> --act-id <ID/링크> --out data
"""
import argparse, os, re, sys, zipfile
import requests

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'}
MIN_SIZE = 1_000_000


def extract_id(s):
    if not s:
        return None
    m = re.search(r'/d/([A-Za-z0-9_-]{20,})', s) or re.search(r'[?&]id=([A-Za-z0-9_-]{20,})', s)
    if m:
        return m.group(1)
    if re.fullmatch(r'[A-Za-z0-9_-]{20,}', s):
        return s
    sys.exit(f'[fetch_gdrive] 파일 ID를 해석하지 못함: {s[:60]}')


def is_html(resp):
    return 'text/html' in resp.headers.get('content-type', '').lower()


def parse_confirm_form(html):
    """확인 페이지에서 form action과 hidden 파라미터를 추출."""
    action = None
    m = re.search(r'<form[^>]+id="download-form"[^>]+action="([^"]+)"', html) \
        or re.search(r'<form[^>]+action="([^"]+)"[^>]*>', html)
    if m:
        action = m.group(1).replace('&amp;', '&')
    params = {}
    for nm, val in re.findall(r'<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"', html):
        params[nm] = val
    # 순서 반대 속성도 대응
    for val, nm in re.findall(r'<input[^>]+value="([^"]*)"[^>]+name="([^"]+)"', html):
        params.setdefault(nm, val)
    return action, params


def stream_to_file(r, out_dir, file_id):
    cd = r.headers.get('content-disposition', '')
    fname = ''
    m = re.search(r"filename\*=UTF-8''([^;]+)", cd)
    if m:
        fname = requests.utils.unquote(m.group(1))
    else:
        m = re.search(r'filename="?([^";]+)', cd)
        if m:
            rawb = m.group(1).encode('latin-1', 'ignore')
            for enc in ('utf-8', 'euc-kr', 'cp949'):
                try:
                    fname = rawb.decode(enc); break
                except UnicodeDecodeError:
                    continue
    if not fname:
        fname = f'{file_id}.zip'
    path = os.path.join(out_dir, fname)
    size = 0
    with open(path, 'wb') as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk); size += len(chunk)
    print(f'[fetch_gdrive] {fname} ({size:,} bytes, {r.headers.get("content-type")})')
    return path, size


def download(file_id, out_dir):
    sess = requests.Session()
    endpoints = [
        'https://drive.google.com/uc',
        'https://drive.usercontent.google.com/download',
    ]
    last_html = None
    for base in endpoints:
        try:
            r = sess.get(base, params={'id': file_id, 'export': 'download'},
                         headers=UA, stream=True, timeout=300)
        except requests.RequestException as e:
            print(f'[fetch_gdrive] {base} 요청 실패: {type(e).__name__}')
            continue
        if r.status_code == 404:
            print(f'[fetch_gdrive] {base} -> 404, 다음 엔드포인트')
            continue

        if not is_html(r):
            # 바로 파일
            path, size = stream_to_file(r, out_dir, file_id)
            if size >= MIN_SIZE:
                return path
            os.remove(path)
            print('[fetch_gdrive] 크기 미달 — 다음 시도')
            continue

        # 확인 페이지 → form 파싱 후 재요청
        html = r.text
        last_html = html
        action, params = parse_confirm_form(html)
        if not action:
            action = 'https://drive.usercontent.google.com/download'
        if action.startswith('/'):
            action = 'https://drive.google.com' + action
        params.setdefault('id', file_id)
        params.setdefault('export', 'download')
        params.setdefault('confirm', 't')
        print(f'[fetch_gdrive] 확인 페이지 처리 → {action} params={list(params.keys())}')
        try:
            r2 = sess.get(action, params=params, headers=UA, stream=True, timeout=900)
        except requests.RequestException as e:
            print(f'[fetch_gdrive] 확인 재요청 실패: {type(e).__name__}')
            continue
        if r2.ok and not is_html(r2):
            path, size = stream_to_file(r2, out_dir, file_id)
            if size >= MIN_SIZE:
                return path
            os.remove(path)

    if last_html:
        print('[fetch_gdrive] 확인 페이지 앞부분:', re.sub(r'\s+', ' ', last_html[:400]))
    sys.exit(f'[fetch_gdrive] id={file_id} 다운로드 실패. 공유가 "링크가 있는 모든 사용자"인지 확인하세요.')


def unzip_all(out_dir):
    for name in os.listdir(out_dir):
        if name.lower().endswith('.zip'):
            p = os.path.join(out_dir, name)
            try:
                with zipfile.ZipFile(p) as z:
                    z.extractall(out_dir)
                print(f'[fetch_gdrive] 해제: {name}')
            except zipfile.BadZipFile:
                print(f'[fetch_gdrive] zip 아님(건너뜀): {name}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--law-id', default=None)
    ap.add_argument('--act-id', default=None)
    ap.add_argument('--out', default='data')
    a = ap.parse_args()
    if not a.law_id and not a.act_id:
        sys.exit('--law-id 또는 --act-id 중 최소 하나 필요')
    os.makedirs(a.out, exist_ok=True)
    if a.law_id:
        download(extract_id(a.law_id), a.out)
    if a.act_id:
        download(extract_id(a.act_id), a.out)
    unzip_all(a.out)
    print('[fetch_gdrive] 완료')


if __name__ == '__main__':
    main()
