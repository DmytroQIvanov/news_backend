"""spaCy models per language: sentence segmentation, NER and dependency parses.

Models are loaded lazily and cached. A language without a model falls back to the multilingual xx_ent_wiki_sm
(NER only) and to the rule-based sentence splitter. When no model is installed at all, the pipeline still runs
with dictionary matching only.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from functools import lru_cache

from ..config import settings
from ..text.normalize import split_sentences

log = logging.getLogger(__name__)
_lock = threading.Lock()

LABEL_MAP = {
    "PERSON": "person", "PER": "person",
    "ORG": "organization",
    "GPE": "place", "LOC": "place", "FAC": "facility",
    "PRODUCT": "product", "NORP": "group", "EVENT": "event", "LAW": "law",
    "MISC": "other", "WORK_OF_ART": "other",
}
KEEP_LABELS = set(LABEL_MAP)


@dataclass
class Token:
    i: int
    text: str
    lemma: str
    pos: str
    dep: str
    head: int
    start: int  # char offset in the document text
    morph: str = ""  # e.g. "Aspect=Perf|Tense=Fut" (used for Ukrainian future tense = plan)


@dataclass
class Sentence:
    idx: int
    text: str
    start: int
    end: int
    tokens: list[Token] = field(default_factory=list)
    has_parse: bool = False


@dataclass
class Entity:
    text: str
    label: str
    start: int
    end: int
    sentence_idx: int


@dataclass
class Parsed:
    sentences: list[Sentence]
    entities: list[Entity]
    model: str | None


def _model_names() -> dict[str, str]:
    out: dict[str, str] = {}
    for item in settings.spacy_models:
        if ":" in item:
            lang, name = item.split(":", 1)
            out[lang.strip()] = name.strip()
    return out


@lru_cache(maxsize=8)
def _load(name: str):
    import spacy  # type: ignore

    try:
        nlp = spacy.load(name, exclude=["textcat"])
    except Exception as exc:
        log.warning("spaCy model %s is not available: %s", name, exc)
        return None
    if not nlp.has_pipe("parser") and not nlp.has_pipe("senter") and not nlp.has_pipe("sentencizer"):
        nlp.add_pipe("sentencizer")
    nlp.max_length = max(nlp.max_length, settings.max_body_chars + 1000)
    log.info("loaded spaCy model %s (%s)", name, ", ".join(nlp.pipe_names))
    return nlp


def model_for(lang: str):
    names = _model_names()
    with _lock:
        if lang in names:
            nlp = _load(names[lang])
            if nlp is not None:
                return names[lang], nlp
        if "xx" in names:
            nlp = _load(names["xx"])
            if nlp is not None:
                return names["xx"], nlp
    return None, None


def parse(text: str, lang: str) -> Parsed:
    name, nlp = model_for(lang)
    if nlp is None:
        sentences: list[Sentence] = []
        pos = 0
        for idx, s in enumerate(split_sentences(text)):
            start = text.find(s[:20], pos)
            start = start if start >= 0 else pos
            sentences.append(Sentence(idx, s, start, start + len(s)))
            pos = start + len(s)
        return Parsed(sentences, [], None)
    doc = nlp(text)
    has_parse = nlp.has_pipe("parser")
    sentences = []
    sent_of_token: dict[int, int] = {}
    for idx, sent in enumerate(doc.sents):
        toks = [
            Token(t.i - sent.start, t.text, (t.lemma_ or t.text).lower(), t.pos_, t.dep_, t.head.i - sent.start, t.idx, str(t.morph))
            for t in sent
        ]
        for t in sent:
            sent_of_token[t.i] = idx
        sentences.append(Sentence(idx, sent.text, sent.start_char, sent.end_char, toks, has_parse))
    ents = [
        Entity(e.text, LABEL_MAP[e.label_], e.start_char, e.end_char, sent_of_token.get(e.start, 0))
        for e in doc.ents
        if e.label_ in KEEP_LABELS and len(e.text.strip()) > 1
    ]
    return Parsed(sentences, ents, name)
