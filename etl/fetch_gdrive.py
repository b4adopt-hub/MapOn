# -*- coding: utf-8 -*-
"""구글 드라이브 공유 링크에서 LURIS 파일 다운로드.
방식 A(링크 고정): 워크플로 Secrets/입력으로 파일 ID를 받아 내려받는다.

구글 드라이브 특성:
 - 100MB 미만 파일도 대용량으로 분류되면 '바이러스 검사 불가' 확인 페이지(HTML)를 먼저 반환한다.
 - 이 경우 응답에서 confirm 토큰(또는 uuid)을 뽑아 재요청하면 실제 파일을 받는다.
 - 신형 엔드포인트는 https://drive.usercontent.google.com/download?id=..&export=download&confirm=t 로 처리된다.

사용법:
  python fetch_gdrive.py --law-id <파일ID> --act-id <파일ID> --out data
  ID 하나만 줘도 됨(그 파일만 받음). ID는 공유링크
  https://drive.google.com/file/d/<여기>/view 의 가운데 값.
"""
import argparse, os, re, sys, zipfile
import requests

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'}
MIN_SIZE = 1_000_000  # 이보다 작으면 데이터 파일 아님(HTML 경고 페이지 등)


def extract_id(s):
    """공유 링크나 순수 ID에서 파일 ID만 뽑는다."""
    if not s:
        return None
    m = re.search(r'/d/([A-Za-z0-9_-]{20,})', s) or re.search(r'[?&]id=([A-Za-z0-9_-]{20,})', s)
    if m:
        return m.group(1)
    if re.fullmatch(r'[A-Za-z0-9_-]{20,}', s):
        return s
    sys.exit(f'[fetch_gdrive] 파일 ID를 해석하지 못함: {s[:60]}')


def download(file_id, out_dir):
    sess = requests.Session()
    base = 'https://drive.usercontent.google.com/download'
    params = {'id': file_id, 'export': 'download'}
    r = sess.get(base, params=params, headers=UA, stream=True, timeout=300)

    # 확인 페이지(HTML)면 confirm 토큰을 뽑아 재요청
    ctype = r.headers.get('content-type', '')
    if 'text/html' in ctype:
        html = r.text
        token = None
        m = re.search(r'name="confirm"\s+value="([^"]+)"', html) or re.search(r'[?&]confirm=([A-Za-z0-9_-]+)', html)
        if m:
            token = m.group(1)
        uuid_m = re.search(r'name="uuid"\s+value="([^"]+)"', html)
        params2 = {'id': file_id, 'export': 'download', 'confirm': token or 't'}
        if uuid_m:
            params2['uuid'] = uuid_m.group(1)
        r = sess.get(base, params=params2, headers=UA, stream=True, timeout=900)

    r.raise_for_status()
    # 파일명 추출
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
    if size < MIN_SIZE:
        # HTML이 저장된 경우 내용 일부 로그
        with open(path, 'rb') as f:
            head = f.read(500)
        print('[fetch_gdrive] 크기 미달 — 파일이 아니라 페이지일 수 있음. 앞부분:', head[:300])
        sys.exit('[fetch_gdrive] 다운로드 실패. 공유 설정이 "링크가 있는 모든 사용자"인지 확인하세요.')
    return path


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
