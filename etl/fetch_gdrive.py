# -*- coding: utf-8 -*-
"""구글 드라이브 공유 링크에서 LURIS 파일 다운로드 (gdown 사용).
방식 A(링크 고정): 워크플로 Secrets/입력으로 파일 ID를 받아 내려받는다.

gdown은 구글 드라이브 다운로드에 특화된 라이브러리로,
엔드포인트 변화·대용량 확인 토큰·쿠키를 내부에서 처리한다.
공유 설정은 "링크가 있는 모든 사용자(뷰어)"여야 한다.

사용법:
  python fetch_gdrive.py --law-id <ID/링크> --act-id <ID/링크> --out data
"""
import argparse, os, re, sys, zipfile
import gdown


def extract_id(s):
    if not s:
        return None
    m = re.search(r'/d/([A-Za-z0-9_-]{20,})', s) or re.search(r'[?&]id=([A-Za-z0-9_-]{20,})', s)
    if m:
        return m.group(1)
    if re.fullmatch(r'[A-Za-z0-9_-]{20,}', s):
        return s
    sys.exit(f'[fetch_gdrive] 파일 ID를 해석하지 못함: {s[:60]}')


def download(file_id, out_dir):
    # gdown 6.x: id= 로 지정, output은 디렉토리(끝에 os.sep)면 서버 파일명 유지
    path = gdown.download(id=file_id, output=out_dir + os.sep, quiet=False)
    if not path or not os.path.exists(path):
        sys.exit(f'[fetch_gdrive] id={file_id} 다운로드 실패. 공유가 "링크가 있는 모든 사용자(뷰어)"인지 확인하세요.')
    size = os.path.getsize(path)
    print(f'[fetch_gdrive] {os.path.basename(path)} ({size:,} bytes)')
    if size < 1_000_000:
        sys.exit(f'[fetch_gdrive] 크기 미달({size} bytes) — 파일이 아니라 페이지일 수 있음.')
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
