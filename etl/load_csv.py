# -*- coding: utf-8 -*-
"""사전 파싱된 CSV(gzip)를 Supabase에 직접 COPY 적재.
컨테이너에서 이미 파싱을 끝낸 permitted_uses / zoning_rates 데이터를 워크플로가 그대로 넣을 때 사용.
파싱 로직을 다시 돌리지 않으므로 대용량도 빠르다.

CSV 컬럼 순서(헤더 없음)는 대상 테이블 컬럼과 일치해야 한다:
  permitted_uses: sgg_code,sgg_name,zone_nm,law_name,land_use,decision,condition_note,is_ordinance,src_month
  zoning_rates:   sgg_code,zone_cd,zone_nm,rate_kind,category,rate_pct,rate_values,ordinance,provision,enforce_dt,content,needs_review,src_month

사용법:
  python load_csv.py --table permitted_uses --csv-gz data/permitted_uses.csv.gz --month 202606
"""
import argparse, gzip, os, sys
import psycopg2

COLS = {
    'permitted_uses': ['sgg_code','sgg_name','zone_nm','law_name','land_use','decision','condition_note','is_ordinance','src_month'],
    'zoning_rates': ['sgg_code','zone_cd','zone_nm','rate_kind','category','rate_pct','rate_values','ordinance','provision','enforce_dt','content','needs_review','src_month'],
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--table', required=True, choices=list(COLS))
    ap.add_argument('--csv-gz', required=True)
    ap.add_argument('--month', required=True)
    a = ap.parse_args()
    url = os.environ.get('DATABASE_URL')
    if not url:
        sys.exit('DATABASE_URL 필요')
    cols = COLS[a.table]

    conn = psycopg2.connect(url)
    conn.autocommit = False
    cur = conn.cursor()
    print(f'[load_csv] {a.table}: {a.month} 기존 데이터 삭제')
    cur.execute(f'delete from public.{a.table} where src_month = %s', (a.month,))

    print(f'[load_csv] {a.table}: COPY 시작')
    with gzip.open(a.csv_gz, 'rt', encoding='utf-8') as f:
        cur.copy_expert(
            f"copy public.{a.table} ({','.join(cols)}) from stdin with (format csv)",
            f,
        )
    conn.commit()
    cur.execute(f'select count(*) from public.{a.table}')
    print(f'[load_csv] {a.table}: 총 {cur.fetchone()[0]:,}행')
    conn.close()
    print('[load_csv] 완료')

if __name__ == '__main__':
    main()
