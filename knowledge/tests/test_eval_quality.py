"""Quality gate: claim extraction must not regress on the gold set (needs the spaCy models en/uk)."""
import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # noqa: E401,E702

import pytest

import os
if os.environ.get("KB_REQUIRE_QUALITY_TESTS") == "true":
    import spacy  # required in CI; a missing dependency must fail collection
else:
    spacy = pytest.importorskip("spacy")
try:
    spacy.load("en_core_web_sm")
    spacy.load("uk_core_news_sm")
except OSError:  # pragma: no cover - models not installed in this environment
    if os.environ.get("KB_REQUIRE_QUALITY_TESTS") == "true":
        raise RuntimeError("Required quality models are missing")
    pytest.skip("spaCy models en_core_web_sm / uk_core_news_sm are not installed", allow_module_level=True)


def test_claim_extraction_quality_gate(monkeypatch):
    monkeypatch.setenv("KB_SPACY_MODELS", "en:en_core_web_sm,uk:uk_core_news_sm")
    from kb.evaluate import evaluate

    overall = evaluate(verbose=False)["overall"]
    # Measured 2026-11-17: precision 0.96, recall 0.90, F1 0.93 (German cases included, weakest part).
    assert overall["precision"] >= 0.92
    assert overall["recall"] >= 0.85
    assert overall["modality_acc"] >= 0.95
    assert overall["negation_acc"] >= 0.98
