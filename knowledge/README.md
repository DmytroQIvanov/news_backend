# knowledge/ — algorithmic knowledge base (`python -m kb`)

Architecture, options and roadmap: [docs/KNOWLEDGE_PIPELINE.md](../docs/KNOWLEDGE_PIPELINE.md).

```
kb/
  collect/   feeds (feedparser + httpx), text extraction (trafilatura, JSON-LD, AMP), boilerplate removal
  text/      normalization, fingerprints, language id, lemma keys, keywords, dates, money/quantities
  nlp/       spaCy NER/parse, gazetteer, entity linking, categorization, claims, embeddings, worker pipeline
  graph/     event clustering, facts & contradictions, importance/editorial state, storylines & event links
  enrich/    Wikidata resolution and identifiers
  llm/       budgeted escalation queue (kb.llm_tasks)
  maintain.py  periodic graph maintenance;  train.py  category classifier;  legacy.py  history backfill
resources/   taxonomy.yaml, predicates.yaml, seed_entities.yaml, source_tiers.yaml, stopwords_uk.txt
```

Local run without Docker (Python 3.12+):

```bash
pip install -r requirements.txt pytest
python -m spacy download en_core_web_sm && python -m spacy download uk_core_news_sm
python -m pytest tests -q
export KB_DATABASE_URL=postgresql://radar:...@127.0.0.1:5432/radar KB_MODEL_DIR=./.models
python -m kb seed && python -m kb once && python -m kb stats
echo "Title line
Body text ..." | python -m kb analyze-text      # NLP stack only, no database writes
```

Server: `compose.server.yaml` in the repository root.
