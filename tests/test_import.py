import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from import_ai_news import normalize, slugify

class ImportTest(unittest.TestCase):
    def test_serialize_previous_ai_news_output(self):
        groups=normalize([{'id':'a1','title':'New model','summary':'From RSS','url':'https://example.com/news',
                           'source':'Anthropic News (community feed)','topic':'models','published_at':'2026-11-14T00:00:00+00:00',
                           'ai':{'title_uk':'Нова модель','summary_uk':'Опис','category':'model','importance':'high','free_access':'unknown'}}])
        self.assertEqual(len(groups),1)
        self.assertEqual(groups[0]['source']['slug'],'anthropic-news-community-feed')
        item=groups[0]['items'][0]
        self.assertEqual(item['titleUk'],'Нова модель')
        self.assertEqual(item['freeAccess'],'unknown')
    def test_reject_non_https(self):
        self.assertEqual(normalize([{'title':'bad','url':'http://bad.site'}]),[])
    def test_slug(self):
        self.assertEqual(slugify('OpenAI News'),'openai-news')
if __name__=='__main__': unittest.main()
