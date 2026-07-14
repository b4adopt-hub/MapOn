# -*- coding: utf-8 -*-
"""적재 가드: 최근 20일 이내 적재 이력이 있으면 skip=true 출력 (스케줄 중복 실행 방지)"""
import os, sys
import psycopg2

url = os.environ.get('DATABASE_URL')
if not url:
    sys.exit('DATABASE_URL 필요')
conn = psycopg2.connect(url)
cur = conn.cursor()
cur.execute("select coalesce(max(created_at) > now() - interval '20 days', false) from public.zoning_rates")
loaded = cur.fetchone()[0]
conn.close()
out = os.environ.get('GITHUB_OUTPUT')
if out:
    with open(out, 'a') as f:
        f.write(f'skip={"true" if loaded else "false"}\n')
print('이번 달 적재 이력:', '있음 — 스킵' if loaded else '없음 — 진행')
