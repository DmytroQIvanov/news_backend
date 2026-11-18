"""Claim extraction: "who did what to whom, how much, when, and who says so" — rules over dependency parses.

For every sentence that contains at least one entity mention:
  1. find trigger verbs (lemma lexicon) or trigger phrases (resources/predicates.yaml);
  2. assign roles from the parse: subject (nsubj/sb), object (obj/oa/obl/...), passive agent (agent/obl:agent/pg);
     passive voice swaps roles; conj/xcomp verbs inherit the subject of their head verb;
  3. without a parse (or when roles are missing) fall back to word order: nearest mention left/right of the trigger;
  4. attach amount (money/quantity), time (resolved dates), modality (fact/plan/claim/speculation/denial), negation,
     and attribution ("X said that ...", "за словами X").
Confidence reflects the evidence: parse-based > pattern-based; linked entities > raw names; speculation lowers it.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path

import yaml

from ..text.stem import stem_token
from .linker import Mention
from .ner import Parsed, Sentence

log = logging.getLogger(__name__)
_LEXICON = Path(__file__).resolve().parents[1] / "resources" / "predicates.yaml"

SUBJ = {"nsubj", "csubj", "sb", "nsubj:pass", "nsubjpass", "csubj:pass"}
PASSIVE_SUBJ = {"nsubj:pass", "nsubjpass", "csubj:pass"}
PASSIVE_MARK = {"auxpass", "aux:pass", "expl:pass"}
AGENT = {"agent", "obl:agent", "pg", "sbp"}
OBJ = {"obj", "dobj", "oa", "iobj", "dative", "da", "obl", "pobj", "nmod", "attr", "op", "oprd", "obl:arg", "obj:arg", "mo", "nk", "prep"}
INHERIT = {"conj", "xcomp", "cj", "ccomp", "advcl", "oc"}
# Adjective-like nationality mentions ("Israeli", "російські") are context, not participants.
ROLE_LABELS_EXCLUDED = {"group"}
SPEECH = "state"


@dataclass
class Claim:
    sentence_idx: int
    sentence: str
    predicate: str
    event_type: str
    subject: Mention | None
    obj: Mention | None
    object_text: str | None = None
    value_num: float | None = None
    value_unit: str | None = None
    time_text: str | None = None
    time_start: date | None = None
    time_end: date | None = None
    modality: str = "fact"
    negated: bool = False
    attributed_to: Mention | None = None
    confidence: float = 0.5
    extractor: str = "pattern:v1"
    extra: dict = field(default_factory=dict)


@dataclass
class _Pred:
    name: str
    event_type: str
    lemmas: dict[str, set[str]]
    stems: dict[str, set[str]]
    phrases: dict[str, list[str]]
    object_kinds: set[str]
    amount: bool
    functional: bool
    symmetric: bool
    durable: bool


class Lexicon:
    def __init__(self, data: dict):
        self.preds: dict[str, _Pred] = {}
        self.by_lemma: dict[str, dict[str, list[_Pred]]] = {}
        self.by_stem: dict[str, dict[str, list[_Pred]]] = {}
        for name, spec in (data.get("predicates") or {}).items():
            lemmas = {lang: {str(x).lower() for x in (v or [])} for lang, v in (spec.get("lemmas") or {}).items()}
            stems = {lang: {stem_token(x) for x in v} for lang, v in lemmas.items()}
            p = _Pred(
                name=name,
                event_type=spec.get("event_type", name),
                lemmas=lemmas,
                stems=stems,
                phrases={lang: [str(x).lower() for x in (v or [])] for lang, v in (spec.get("phrases") or {}).items()},
                object_kinds=set(spec.get("object_kinds") or []),
                amount=bool(spec.get("amount")),
                functional=bool(spec.get("functional")),
                symmetric=bool(spec.get("symmetric")),
                durable=bool(spec.get("durable")),
            )
            self.preds[name] = p
            for lang, words in lemmas.items():
                for w in words:
                    self.by_lemma.setdefault(lang, {}).setdefault(w, []).append(p)
            for lang, words in stems.items():
                for w in words:
                    self.by_stem.setdefault(lang, {}).setdefault(w, []).append(p)
        self.modality: dict[str, dict[str, re.Pattern]] = {}
        for kind, per_lang in (data.get("modality") or {}).items():
            for lang, patterns in (per_lang or {}).items():
                self.modality.setdefault(kind, {})[lang] = re.compile("|".join(f"(?:{p})" for p in patterns), re.I | re.U)

    def cue(self, kind: str, lang: str, text: str) -> bool:
        pat = self.modality.get(kind, {}).get(lang) or self.modality.get(kind, {}).get("en")
        return bool(pat and pat.search(text))


@lru_cache(maxsize=1)
def lexicon() -> Lexicon:
    return Lexicon(yaml.safe_load(_LEXICON.read_text(encoding="utf-8")) or {})


def _lang_key(lang: str) -> str:
    return lang if lang in ("en", "uk", "de", "ru") else "en"


def _mentions_in(sentence: Sentence, mentions: list[Mention]) -> list[Mention]:
    return [m for m in mentions if sentence.start <= m.start < sentence.end]


def _head_token(sentence: Sentence, m: Mention) -> int | None:
    inside = [t for t in sentence.tokens if m.start <= t.start < m.end]
    if not inside:
        return None
    ids = {t.i for t in inside}
    for t in inside:
        if t.head not in ids or t.head == t.i:
            return t.i
    return inside[0].i


def _path_role(sentence: Sentence, token_i: int, trigger_i: int, max_up: int = 5) -> str | None:
    """Dep label of the edge that connects the mention's head (possibly through modifiers) to the trigger."""
    toks = sentence.tokens
    cur = token_i
    for step in range(max_up):
        t = toks[cur]
        if t.head == trigger_i and cur != trigger_i:
            return t.dep.lower()
        if t.head == cur:  # root
            return None
        # Crossing another verb means the mention belongs to a different clause.
        if step > 0 and t.pos in ("VERB", "AUX"):
            return None
        cur = t.head
    return None


def _pronoun_subject(sentence: Sentence, verb_i: int) -> bool:
    return any(c.dep.lower() in SUBJ and c.pos == "PRON" for c in _children(sentence, verb_i))


def _nominal_anaphora(sentence: Sentence, verb_i: int) -> bool:
    """Subject is "the company"/"компанія" (directly or of a governing verb: "Компанія заявила, що уклала ...")."""
    cur = verb_i
    for _ in range(3):
        if any(c.dep.lower() in SUBJ and (c.lemma in NOMINAL_ANAPHORA or c.pos == "PRON") for c in _children(sentence, cur)):
            return True
        t = sentence.tokens[cur]
        if t.head == cur:
            return False
        cur = t.head
    return False


def _governing_subject(sentence: Sentence, verb_i: int, heads: dict[int, Mention]) -> Mention | None:
    """'NVIDIA said it will acquire X' / 'X plans to buy Y': walk up clause heads to a verb with an entity subject."""
    cur = verb_i
    for _ in range(4):
        t = sentence.tokens[cur]
        if t.head == cur:
            return None
        if t.dep.lower() in ("relcl", "acl:relcl", "advcl", "parataxis") and t.pos in ("VERB", "AUX"):
            return None  # a relative/adverbial clause has its own subject
        cur = t.head
        subj = _subject_of(sentence, cur, heads)
        if subj is not None:
            return subj
    return None


# Definite descriptions that refer back to the previous actor ("Компанія заявила", "The company said").
NOMINAL_ANAPHORA = {"company", "firm", "group", "startup", "bank", "government", "ministry", "operator", "manufacturer",
                    "компанія", "фірма", "група", "стартап", "банк", "уряд", "міністерство", "оператор", "виробник",
                    "корпорація", "холдинг", "unternehmen", "konzern", "firma", "regierung", "компания"}
# Nouns that name an action: "заперечив придбання X" = denied acquiring X.
NOMINALIZATIONS = {"придбання": "acquire", "купівля": "acquire", "поглинання": "acquire", "acquisition": "acquire",
                   "takeover": "acquire", "übernahme": "acquire", "атака": "attack", "удар": "attack", "attack": "attack",
                   "strike": "attack", "angriff": "attack", "інвестиція": "invest_in", "investment": "invest_in",
                   "угода": "sign_agreement", "deal": "sign_agreement", "злам": "breach", "hack": "breach", "breach": "breach",
                   "звільнення": "dismiss", "відставка": "resign", "запуск": "launch", "launch": "launch"}
TRADE_GOODS = re.compile(r"wheat|grain|corn|gas|oil|coal|steel|fertili[sz]er|сталь|пшениц|зерн|кукурудз|газ\b|нафт|вугілл|"
                         r"добрив|weizen|getreide|öl\b|kohle|stahl|tonn|тонн", re.I)
SENTENCE_RE = re.compile(r"\bдо\s+\d+\s+(?:рок|літ|міс)|позбавлення волі|ув.язненн|умовн\w* терм|sentenced|in prison|haft", re.I)
SUSPICION_RE = re.compile(r"про підозру|підозру в|підозру у|charged with|anklage", re.I)
ACCORDING_RE = re.compile(r"(?:за словами|according to|laut|zufolge|по словам)\s*$", re.I)
EMPLOYEES_RE = re.compile(r"(\d[\d\s.,]*)\s*(?:employees|workers|staff|jobs|people|працівник\w*|співробітник\w*|"
                          r"робочих місць|людей|Mitarbeiter\w*|Stellen)", re.I)


def _remap(claim_pred: str, scope: str, subj, kinds: dict[int, str]) -> str:
    """Homonyms resolved by context: verdicts vs condemnation, suspicion notices, trade vs aid."""
    if claim_pred == "condemn" and SENTENCE_RE.search(scope):
        return "convict"
    if claim_pred == "state" and SUSPICION_RE.search(scope):
        return "charge"
    if claim_pred in ("provide", "supply_trade"):
        if TRADE_GOODS.search(scope):
            return "supply_trade"
        skind = kinds.get(subj.entity_id) if subj is not None and subj.entity_id else None
        if skind in ("company",):
            return "supply_trade"
        if skind in ("place", "government", "organization"):
            return "provide"
    return claim_pred


def _children(sentence: Sentence, i: int) -> list:
    return [t for t in sentence.tokens if t.head == i and t.i != i]


def _subject_of(sentence: Sentence, verb_i: int, heads: dict[int, Mention]) -> Mention | None:
    for t in _children(sentence, verb_i):
        if t.dep.lower() in SUBJ and t.dep.lower() not in PASSIVE_SUBJ:
            for hi, m in heads.items():
                if hi == t.i or _path_role(sentence, hi, verb_i) in SUBJ - PASSIVE_SUBJ:
                    return m
    return None


# Children that start another clause: their numbers, dates and modal words belong to that clause, not to ours.
CLAUSE_DEPS = {"conj", "ccomp", "advcl", "parataxis", "acl", "relcl", "acl:relcl", "csubj", "cj", "rc", "oc", "re"}
PLAN_LEMMAS = {"will", "would", "shall", "plan", "intend", "aim", "expect", "seek", "prepare", "want", "set",
               "планувати", "збиратися", "зібратися", "мати", "намірятися", "хотіти", "готуватися", "бути",
               "planen", "wollen", "werden", "beabsichtigen", "собираться", "планировать", "намереваться"}
SPEC_LEMMAS = {"may", "might", "could", "reportedly", "allegedly", "likely", "possibly", "probably",
               "могти", "можливо", "ймовірно", "нібито", "імовірно", "мабуть",
               "können", "angeblich", "möglicherweise", "wahrscheinlich", "возможно", "якобы", "вероятно"}
NEG_LEMMAS = {"not", "n't", "never", "не", "ні", "ніколи", "nicht", "kein", "nie", "нет"}


def _clause_tokens(sentence: Sentence, root: int) -> set[int]:
    """Token indices of the trigger's own clause: its subtree without nested clauses."""
    out = {root}
    stack = [root]
    while stack:
        cur = stack.pop()
        for c in _children(sentence, cur):
            if c.dep.lower() in CLAUSE_DEPS and c.pos in ("VERB", "AUX") and c.i not in out:
                continue
            if c.i not in out:
                out.add(c.i)
                stack.append(c.i)
    return out


def _subtree(sentence: Sentence, root: int) -> set[int]:
    out = {root}
    stack = [root]
    while stack:
        cur = stack.pop()
        for c in _children(sentence, cur):
            if c.i not in out:
                out.add(c.i)
                stack.append(c.i)
    return out


def _char_spans(sentence: Sentence, idx: set[int]) -> list[tuple[int, int]]:
    """Sentence-relative char spans of tokens."""
    spans = []
    for t in sentence.tokens:
        if t.i in idx:
            rel = t.start - sentence.start
            spans.append((rel, rel + len(t.text)))
    return spans


def _inside(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(a <= pos < b for a, b in spans)


def _perfective_present(t) -> bool:
    """Ukrainian/Russian perfective verbs in present form mean the future ("придбає" = will acquire).
    Small spaCy models often tag them Tense=Pres; pymorphy3 knows the aspect."""
    if "Tense=Pres" not in t.morph or not re.search(r"[а-яіїєґ]", t.text.lower()):
        return False
    from ..text.stem import _morph

    morph = _morph("uk")
    if morph is None:
        return False
    return any("perf" in p.tag and ("futr" in p.tag or "pres" in p.tag) and "VERB" in p.tag for p in morph.parse(t.text.lower())[:2])


def _syntactic_modality(sentence: Sentence, tok_i: int) -> tuple[str | None, bool]:
    """(modality or None if undecided, negated) from aux/advmod children and governing verbs."""
    t = sentence.tokens[tok_i]
    kids = _children(sentence, tok_i)
    lemmas = {c.lemma for c in kids if c.dep.lower() in ("aux", "aux:pass", "advmod", "neg", "mark", "discourse", "mo", "ng")}
    negated = any(c.lemma in NEG_LEMMAS or c.dep.lower() == "neg" for c in kids)
    if lemmas & SPEC_LEMMAS:
        return "speculation", negated
    if lemmas & PLAN_LEMMAS or "Tense=Fut" in t.morph or _perfective_present(t):
        return "plan", negated
    # governing verbs: "plans to buy", "може передати", "збирається придбати"
    cur = t
    for _ in range(3):
        if cur.dep.lower() not in ("xcomp", "ccomp", "oc", "acl", "nmod", "obj") or cur.head == cur.i:
            break
        cur = sentence.tokens[cur.head]
        if cur.lemma in SPEC_LEMMAS:
            return "speculation", negated
        if cur.lemma in PLAN_LEMMAS or "Tense=Fut" in cur.morph or _perfective_present(cur):
            return "plan", negated
        negated = negated or any(c.lemma in NEG_LEMMAS for c in _children(sentence, cur.i))
    return ("fact" if "Tense=Past" in t.morph or t.morph else None), negated


def _pick_amount(sentence: str, lang: str, spans: list[tuple[int, int]] | None = None, near: int | None = None,
                 percent: bool = False):
    """Amount of THIS action: inside its clause when the parse is known; else the one nearest after the trigger."""
    try:
        from ..text.money import extract_money, extract_quantities
    except Exception:  # pragma: no cover - optional module
        return None, None
    cands = [(m.start, m.amount, m.currency) for m in extract_money(sentence, lang)]
    if not cands:
        cands = [(q.start, q.value, q.unit) for q in extract_quantities(sentence, lang) if percent or q.unit != "percent"]
    if not cands:
        return None, None
    if spans is not None:
        inside = [c for c in cands if _inside(c[0], spans)]
        if not inside:
            return None, None
        c = inside[0]
        return c[1], c[2]
    if near is not None:
        after = [c for c in cands if c[0] >= near] or cands
        c = min(after, key=lambda x: abs(x[0] - near))
        return c[1], c[2]
    c = max(cands, key=lambda x: x[1])
    return c[1], c[2]


def _pick_time(sentence: str, lang: str, ref: datetime | None, spans: list[tuple[int, int]] | None = None):
    if ref is None:
        return None, None, None
    try:
        from ..text.temporal import extract_time_expressions
    except Exception:  # pragma: no cover
        return None, None, None
    found = [t for t in extract_time_expressions(sentence, lang, ref) if t.value_start
             and not (t.text.strip() in ("may", "march", "Mai") and t.granularity == "month")]
    if spans is not None:
        own = [t for t in found if _inside(t.start, spans)]
        found = own or found  # dates are often sentence-level adverbials ("12 листопада ...")
    if not found:
        return None, None, None
    t = min(found, key=lambda x: {"day": 0, "week": 1, "month": 2, "quarter": 3, "year": 4, "decade": 5}.get(x.granularity, 6))
    return t.text, t.value_start, t.value_end


NON_AGENT_KINDS = {"weapon", "product", "model", "technology", "law", "facility", "event"}
# "у Берліні", "in Brussels", "в Парижі": where it happened, not who it happened to.
LOC_CASE = {"in", "at", "у", "в", "на", "під", "im", "in", "bei", "an", "во", "near", "біля", "поблизу"}
PLACE_TARGETS = {"attack", "destroy", "capture", "liberate", "visit", "ban", "sanction",
                 "invest_in", "raise_funds"}  # "invest in X": the preposition marks the target, not a place


def _is_location(sentence: Sentence, head_i: int, m: Mention, pred: _Pred, kinds: dict[int, str]) -> bool:
    if pred.name in PLACE_TARGETS:
        return False
    kind = kinds.get(m.entity_id) if m.entity_id else ("place" if m.label == "place" else None)
    if kind not in ("place", "facility"):
        return False
    case = [c for c in _children(sentence, head_i) if c.dep.lower() in ("case", "prep", "mo") or c.pos == "ADP"]
    if case:
        return any(c.lemma in LOC_CASE for c in case)
    # English "pobj": the preposition is the head of the mention
    head = sentence.tokens[sentence.tokens[head_i].head]
    return head.pos == "ADP" and head.lemma in LOC_CASE


def _kind_ok(pred: _Pred, m: Mention | None, kinds: dict[int, str]) -> bool:
    if not pred.object_kinds or m is None or not m.entity_id:
        return True
    kind = kinds.get(m.entity_id)
    return kind is None or kind in pred.object_kinds  # unknown kind: do not veto


def extract_claims(
    parsed: Parsed,
    mentions: list[Mention],
    lang: str,
    published_at: datetime | None,
    entity_kinds: dict[int, str] | None = None,
) -> list[Claim]:
    lex = lexicon()
    lk = _lang_key(lang)
    kinds = entity_kinds or {}
    claims: list[Claim] = []
    prev_subject: Mention | None = None
    for s in parsed.sentences:
        from .attribution import citations

        cited = [(c.start + s.start, c.end + s.start) for c in citations(s.text)]
        ms = [m for m in _mentions_in(s, mentions)
              if (m.label not in ROLE_LABELS_EXCLUDED or (m.entity_id and kinds.get(m.entity_id) not in (None, "place")))
              and not any(a <= m.start < b for a, b in cited)]
        # "За словами Макрона, ..." / "According to the minister X, ...": the speaker is not a participant.
        according = [m for m in ms if ACCORDING_RE.search(s.text[max(0, m.start - s.start - 25): m.start - s.start])]
        ms = [m for m in ms if m not in according]
        if not ms and (prev_subject is None or not s.has_parse):  # "It will launch ..." needs no mention
            continue
        low = s.text.lower()
        sent_claims: list[Claim] = []
        heads: dict[int, Mention] = {}
        if s.has_parse and s.tokens:
            for m in ms:
                h = _head_token(s, m)
                if h is not None:
                    heads[h] = m
        triggers: list[tuple[int | None, _Pred, int]] = []  # (token index, predicate, char offset)
        if s.tokens:
            for t in s.tokens:
                if s.has_parse and t.pos not in ("VERB", "AUX", "NOUN", "ADJ"):
                    continue
                cands = lex.by_lemma.get(lk, {}).get(t.lemma) or lex.by_stem.get(lk, {}).get(stem_token(t.text))
                if not cands:
                    continue
                if s.has_parse and t.pos != "VERB" and t.lemma not in ("sanction", "ban", "fine"):
                    continue
                for p in cands:
                    triggers.append((t.i, p, t.start))
        else:
            words = [(m.group(0), m.start()) for m in re.finditer(r"[\w'’-]+", s.text)]
            for w, off in words:
                for p in lex.by_stem.get(lk, {}).get(stem_token(w), []):
                    triggers.append((None, p, s.start + off))
        # Multi-word phrases ("засудив до" = convicted, "у відставку" = resigned) override single-verb homonyms.
        phrase_hits: list[tuple[int, int, _Pred]] = []
        for p in lex.preds.values():
            for phrase in p.phrases.get(lk, []):
                pos = low.find(phrase)
                if pos >= 0:
                    phrase_hits.append((s.start + pos, s.start + pos + len(phrase), p))
                    break
        if phrase_hits:
            covered = [(a, b) for a, b, _ in phrase_hits]
            triggers = [tr for tr in triggers if not any(a <= tr[2] < b for a, b in covered)]
            tok_at = {t.start: t.i for t in s.tokens}
            for a, _b, p in phrase_hits:
                if not any(tr[1].name == p.name for tr in triggers):
                    triggers.append((tok_at.get(a), p, a))

        for tok_i, pred, offset in triggers:
            subj = obj = None
            extractor = "pattern:v1"
            if tok_i is not None and s.has_parse:
                passive = any(c.dep.lower() in PASSIVE_MARK | PASSIVE_SUBJ for c in _children(s, tok_i))
                head_tok = s.tokens[s.tokens[tok_i].head]
                if s.tokens[tok_i].dep.lower() == "oc" and head_tok.lemma == "werden":
                    passive = True  # "wurde ... festgenommen": the subject of "werden" is the patient
                roles: dict[str, Mention] = {}
                for hi, m in heads.items():
                    role = _path_role(s, hi, tok_i)
                    if role is None:
                        continue
                    if role in AGENT:
                        roles.setdefault("agent", m)
                    elif role in PASSIVE_SUBJ:
                        roles.setdefault("psubj", m)
                    elif role in SUBJ:
                        roles.setdefault("subj", m)
                    elif role in OBJ and _kind_ok(pred, m, kinds) and not _is_location(s, hi, m, pred, kinds):
                        roles.setdefault("obj", m)
                if passive and "psubj" not in roles and s.tokens[tok_i].dep.lower() == "oc":
                    roles.update({k: v for k, v in (("psubj", _subject_of(s, head_tok.i, heads)),) if v})
                if passive:
                    subj, obj = roles.get("agent"), roles.get("psubj") or roles.get("obj")
                else:
                    subj, obj = roles.get("subj"), roles.get("obj")
                if subj is None and not passive:
                    subj = _governing_subject(s, tok_i, heads)
                if subj is None and not passive and prev_subject is not None and (
                        _pronoun_subject(s, tok_i) or _nominal_anaphora(s, tok_i)):
                    # "It will buy ..." -> the actor of the previous sentence (simple anaphora, lower confidence)
                    subj = prev_subject
                    extractor = "dep+anaphora:v1"
                if subj or obj:
                    extractor = "dep:v1" if extractor == "pattern:v1" else extractor
            if subj is None and obj is None and not (tok_i is not None and s.has_parse):
                left = [m for m in ms if m.end <= offset]
                right = [m for m in ms if m.start > offset]
                subj = left[-1] if left else None
                right_ok = [m for m in right if _kind_ok(pred, m, kinds) and m is not subj]
                obj = right_ok[0] if right_ok else None
            if pred.object_kinds and obj is not None and not _kind_ok(pred, obj, kinds):
                obj = None
            if subj is not None and subj.entity_id and kinds.get(subj.entity_id) in NON_AGENT_KINDS                     and pred.name not in ("attack", "destroy", "launch"):
                subj = None  # "Shahed raised $700m": weapons, products and laws do not act (except strikes)
            if subj is None and obj is None:
                continue
            if pred.name in (SPEECH, "deny") and subj is None:
                continue  # a quote without a speaker is not a claim
            if subj is not None and obj is not None and subj.entity_id and subj.entity_id == obj.entity_id:
                obj = None
            if pred.object_kinds and obj is None and pred.name in ("liberate", "capture", "appoint", "dismiss", "provide"):
                # homonyms ("звільнити") need a typed object to be trusted
                continue
            spans = _char_spans(s, _clause_tokens(s, tok_i)) if (tok_i is not None and s.has_parse) else None
            clause_text = " ".join(s.text[x:y] for x, y in sorted(spans)) if spans else s.text
            name = _remap(pred.name, clause_text if pred.name != "condemn" else s.text, subj, kinds)
            if name != pred.name:
                pred = lex.preds[name]
            claim = Claim(s.idx, s.text, pred.name, pred.event_type, subj, obj, extractor=extractor)
            claim.extra["tok"] = tok_i
            amount_triggers = sum(1 for tr in triggers if tr[1].amount)
            if pred.amount:
                claim.value_num, claim.value_unit = _pick_amount(
                    s.text, lang, spans, near=None if spans is not None or amount_triggers <= 1 else offset - s.start,
                    percent=pred.name == "win")
                if claim.value_num is None and pred.name == "layoffs":
                    m_emp = EMPLOYEES_RE.search(clause_text)
                    if m_emp:
                        try:
                            claim.value_num, claim.value_unit = float(re.sub(r"[\s,]", "", m_emp.group(1))), "people"
                        except ValueError:
                            pass
            claim.time_text, claim.time_start, claim.time_end = _pick_time(s.text, lang, published_at, spans)
            syn_mod, syn_neg = _syntactic_modality(s, tok_i) if spans is not None else (None, False)
            if spans is not None:
                scope = " ".join(s.text[x:y] for x, y in sorted(spans)).lower()   # the action's own clause
            elif len(triggers) > 1:
                scope = low[max(0, offset - s.start - 40): offset - s.start + 25]  # the trigger's neighbourhood
            else:
                scope = low
            if lex.cue("question", lk, s.text.strip()):
                claim.modality = "question"
            elif pred.name == "deny":
                claim.modality = "denial"
            elif syn_mod in ("speculation", "plan"):
                claim.modality = syn_mod
            elif lex.cue("speculation", lk, scope):
                claim.modality = "speculation"
            elif syn_mod is None and lex.cue("plan", lk, scope):
                claim.modality = "plan"
            claim.negated = pred.name != "deny" and (syn_neg or (spans is None and lex.cue(
                "negation", lk, low[max(0, offset - s.start - 25): offset - s.start + 5])))
            conf = 0.72 if extractor.startswith("dep") else 0.48
            conf += 0.08 * sum(1 for m in (subj, obj) if m is not None and m.entity_id)
            conf -= 0.2 if claim.modality in ("speculation", "question") else 0.0
            claim.confidence = round(max(0.05, min(0.95, conf)), 3)
            if pred.name == SPEECH:
                claim.object_text = s.text[:600]
            elif obj is None:
                claim.object_text = None
            sent_claims.append(claim)

        # Attribution: a speech claim in the same sentence turns the other claims into "X says that ...".
        speech = [c for c in sent_claims if c.predicate in (SPEECH, "deny") and c.subject is not None]
        speakers = [c.subject for c in speech]
        if speakers:
            for c in sent_claims:
                if c.predicate in (SPEECH, "deny"):
                    continue
                # With a parse, only actions inside the speech verb's subtree are "what X said / denied".
                governing = [x for x in speech if x.extra.get("tok") is None or c.extra.get("tok") is None
                             or c.extra["tok"] in _subtree(s, x.extra["tok"])] if s.has_parse else speech
                if not governing:
                    continue
                speaker = governing[0].subject
                denied = any(x.predicate == "deny" for x in governing)
                if denied:
                    # "Acme denied acquiring Beta": the embedded action is a denial, never a fact
                    c.modality = "denial"
                    c.attributed_to = speaker
                    continue
                if c.subject is None or (speaker.entity_id or speaker.key) != (c.subject.entity_id or c.subject.key):
                    c.attributed_to = speaker
                    if c.modality == "fact":
                        c.modality = "claim"
        # "Атлас заперечив придбання Орбіти": the denied action is named by a noun under the deny verb.
        if s.has_parse:
            for d in [c for c in sent_claims if c.predicate == "deny" and c.extra.get("tok") is not None]:
                for t in _subtree(s, d.extra["tok"]):
                    act = NOMINALIZATIONS.get(s.tokens[t].lemma)
                    if not act or act not in lex.preds:
                        continue
                    target = next((m for hi, m in heads.items() if hi in _subtree(s, t) and hi != t and m is not d.subject), None)
                    nc = Claim(s.idx, s.text, act, lex.preds[act].event_type, d.subject, target, modality="denial",
                               attributed_to=d.subject, confidence=d.confidence, extractor=d.extractor)
                    nc.extra["tok"] = t
                    sent_claims.append(nc)
                    break
        if cited:
            for c in sent_claims:
                if c.predicate not in (SPEECH, "deny") and c.modality == "fact":
                    c.modality = "claim"  # "за даними Reuters": reported, the evidence root is the outlet
        if according:
            for c in sent_claims:
                if c.predicate not in (SPEECH, "deny") and c.attributed_to is None:
                    c.attributed_to = according[0]
                    if c.modality == "fact":
                        c.modality = "claim"
        # Two readings of one event: keep the more specific predicate.
        names = {(c.predicate, id(c.subject), id(c.obj)) for c in sent_claims}
        for weaker, stronger in (("sign_agreement", "partner_with"), ("condemn", "convict"), ("provide", "pledge"),
                                 ("announce", "launch"), ("dismiss", "resign")):
            sent_claims = [c for c in sent_claims if not (c.predicate == weaker and any(
                n[0] == stronger and (n[2] == id(c.obj) or n[1] == id(c.subject)) for n in names))]
        # One claim per (predicate, subject, object) per sentence.
        seen: set[tuple] = set()
        for c in sent_claims:
            key = (c.predicate, id(c.subject), id(c.obj))
            if key in seen:
                continue
            seen.add(key)
            claims.append(c)
        actors = [c.subject for c in sent_claims if c.subject is not None and c.subject.entity_id]
        if actors:
            prev_subject = actors[0]
        elif ms and ms[0].entity_id and kinds.get(ms[0].entity_id) not in ("place", "facility", "law", "event"):
            prev_subject = ms[0]
    return claims
