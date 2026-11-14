#!/usr/bin/env python3
"""Import ai_news_uk.json from ai_news_radar.py into NestJS. Python stdlib only."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError

CATS = {'model','api','coding','open_source','research','business','other'}
IMPORTANCE = {'high','medium','low','unknown'}
FREE = {'yes','no','unknown'}

def slugify(name):
    val = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:80]
    if len(val) < 3:
        val = 'src-' + hashlib.sha256(name.encode()).hexdigest()[:12]
    return val

def normalize(rows):
    """Generate batches, grouped by source. Source name is only a label."""
    result = {}
    for article in rows:
        url = article.get('url', '')
        if not url.startswith('https://'):
            continue
        source_name = str(article.get('source') or urlsplit(url).netloc)
        key = slugify(source_name)
        ai = article.get('ai') if isinstance(article.get('ai'),dict) else {}
        ai = ai or {}
        category = ai.get('category') or article.get('topic') or 'other'
        if category not in CATS: category = 'other'
        importance = ai.get('importance') or 'unknown'
        if importance not in IMPORTANCE: importance = 'unknown'
        free = ai.get('free_access') or 'unknown'
        if free not in FREE: free = 'unknown'
        original_title = str(article.get('title') or '').strip()
        if not original_title: continue
        original_summary = str(article.get('summary') or '')
        external_id = str(article.get('id') or hashlib.sha256(url.encode()).hexdigest()[:32])
        item = {
            'externalId': external_id[:250],
            'originalTitle': original_title[:350],
            'originalSummary': original_summary[:2500],
            'url': url,
            'titleUk': str(ai.get('title_uk') or '')[:350],
            'summaryUk': str(ai.get('summary_uk') or '')[:2500],
            'whyItMatters': str(ai.get('why_it_matters') or '')[:1500],
            'category': category,
            'importance': importance,
            'freeAccess': free,
            'aiMetadata': {'confidence': ai.get('confidence','unknown'),
                           'source_is_unofficial': bool(article.get('source_is_unofficial',False)),
                           'rss_only': True}
        }
        published = article.get('published_at')
        if published: item['publishedAt'] = str(published)
        if key not in result:
            result[key] = {'source': {'slug':key,'name':source_name[:160],
                        'homepageUrl': 'https://' + urlsplit(url).netloc,
                        'unofficial':bool(article.get('source_is_unofficial',False))},
                        'items': []}
        result[key]['items'].append(item)
    return list(result.values())

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--file',default='ai_news_uk.json', help='Path to output of ai_news_radar.py')
    p.add_argument('--api',default='http://localhost:3000',help='Backend root URL')
    p.add_argument('--dry-run',action='store_true')
    args=p.parse_args()
    rows=json.loads(Path(args.file).read_text(encoding='utf-8-sig'))
    if not isinstance(rows,list): raise SystemExit('Expected JSON array')
    batches=normalize(rows)
    print('Sources:',len(batches),'Articles:',sum(len(x['items']) for x in batches))
    if args.dry_run:
        for b in batches: print('------',b['source']['name'],len(b['items']))
        return
    key=os.environ.get('INGEST_API_KEY') or getpass.getpass('INGEST_API_KEY (hidden): ').strip()
    if not key: raise SystemExit('Missing INGEST_API_KEY')
    base=args.api.rstrip('/')
    if not (base.startswith('https://') or base.startswith('http://localhost:') or base.startswith('http://127.0.0.1:')):
        raise SystemExit('Remote API must be HTTPS')
    for batch in batches:
        items=batch['items']
        for start in range(0,len(items),25):
            payload={**batch,'items':items[start:start+25]}
            req=Request(base+'/api/v1/ingest/news',data=json.dumps(payload,ensure_ascii=False).encode(),method='POST',headers={
                'Content-Type':'application/json','x-ingest-key':key,'User-Agent':'OpportunityRadarImporter/0.1'})
            try:
                with urlopen(req,timeout=80) as response:
                    print('------', batch['source']['name'],json.loads(response.read().decode()))
            except HTTPError as e:
                msg=e.read(1500).decode('utf-8','replace')
                raise SystemExit(f'HTTP {e.code}: {msg}')
if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    main()
