import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # noqa: E401,E702

from kb.collect.extract import extract_from_html
from kb.graph.clustering import score_candidate, weighted_jaccard
from kb.graph.facts import value_key
from kb.nlp.gazetteer import Gazetteer
from kb.text import lang
from kb.text.normalize import canonical_url, hamming64, simhash64, split_sentences
from kb.text.stem import term_key


def test_canonical_url_strips_tracking_and_amp():
    a = canonical_url("http://www.bbc.com/news/world-123/amp?utm_source=x&b=2&a=1#top")
    b = canonical_url("https://bbc.com/news/world-123?a=1&b=2")
    assert a == b == "https://bbc.com/news/world-123?a=1&b=2"


def test_simhash_near_duplicates():
    base = ("The European Commission proposed a new sanctions package against Russia on Tuesday, targeting "
            "shadow fleet tankers, banks and suppliers of drone components, officials said in Brussels.")
    edited = base.replace("on Tuesday", "on Tuesday morning")
    other = "NVIDIA reported record data center revenue as demand for Blackwell GPUs kept growing in the quarter."
    assert hamming64(simhash64(base), simhash64(edited)) <= 12
    assert hamming64(simhash64(base), simhash64(other)) > 20


def test_ukrainian_inflection_keys_match():
    assert term_key("Володимира Зеленського") == term_key("Володимир Зеленський")
    assert term_key("Зеленському") == term_key("Зеленський")
    assert term_key("NVIDIA's") == term_key("Nvidia")
    assert term_key("ЗСУ") == "зсу"


def test_gazetteer_longest_match_and_caps_guard():
    g = Gazetteer()
    g.add(1, "Володимир Зеленський")
    g.add(1, "Зеленський")
    g.add(2, "AMD")
    g.add(3, "Apple", ambiguous=True)
    text = "Володимира Зеленського підтримали; amd and AMD; an apple a day; Apple shares rose"
    hits = g.find(text)
    surfaces = [h.surface for h in hits]
    assert "Володимира Зеленського" in surfaces
    assert "amd" not in surfaces and "AMD" in surfaces
    assert "apple" not in surfaces and "Apple" in surfaces


def test_language_heuristic():
    assert lang.heuristic("Україна отримає нові системи ППО від партнерів")[0] == "uk"
    assert lang.heuristic("Россия выпустила ракеты по объектам энергетики")[0] == "ru"
    assert lang.heuristic("The company said that it was going to expand in the market")[0] == "en"
    assert lang.heuristic("Die Regierung hat sich auf ein neues Paket für die Ukraine geeinigt")[0] == "de"


def test_sentence_split_keeps_abbreviations():
    s = split_sentences("Компанія залучила 2 млн. доларів. Інвестори задоволені. Dr. Smith agreed.")
    assert len(s) == 2 or len(s) == 3
    assert s[0].startswith("Компанія")


def test_extraction_marks_teaser_and_paywall():
    paywalled = "<html><body><article><p>Short intro text about the deal.</p><p>Subscribe to continue reading</p></article></body></html>"
    ext = extract_from_html(paywalled, "https://example.com/a", feed_text="Short intro text about the deal.")
    assert ext.status in ("teaser", "partial")
    long_body = " ".join(["The ministry said the new rules would apply from January and affect thousands of companies."] * 30)
    page = f"<html><head><title>T</title></head><body><article><h1>Title</h1><p>{long_body}</p></article></body></html>"
    full = extract_from_html(page, "https://example.com/b")
    assert full.status == "full"


def test_value_key_buckets_two_significant_digits():
    assert value_key(1.2e9, "USD") == value_key(1.24e9, "USD")
    assert value_key(1.2e9, "USD") != value_key(1.5e9, "USD")
    assert value_key(None, None) == ""


def test_cluster_scoring_guards_topic_drift():
    assert weighted_jaccard({1: 1.0, 2: 0.5}, {1: 1.0, 2: 0.5}) == 1.0
    same = score_candidate(sem=0.82, ent=0.6, title_sim=0.5, hours_apart=3, doc_type="acquisition", event_type="acquisition", same_category=True)
    drift = score_candidate(sem=0.7, ent=0.0, title_sim=0.3, hours_apart=3, doc_type=None, event_type=None, same_category=True)
    assert same > 0.52 > drift
