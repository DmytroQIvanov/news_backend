"""Pure-function tests: video transcripts (VTT, VAD regions, time map, whisper JSON) and the new data parsers."""
import xml.etree.ElementTree as ET

from kb.connectors import sdmx, ukraine
from kb.video import gemini, media


def test_vtt_rolling_auto_captions_keep_only_new_words():
    vtt = """WEBVTT

00:00:01.000 --> 00:00:03.000
<c>Добрий</c> день

00:00:03.000 --> 00:00:05.000
Добрий день
сьогодні говоримо про енергетику.

00:00:30.000 --> 00:00:33.000
Нова тема: ціни на газ.
"""
    segs = media.parse_vtt(vtt)
    assert segs[0][0] == 1.0
    assert segs[0][1] == "Добрий день сьогодні говоримо про енергетику."
    assert segs[1] == (30.0, "Нова тема: ціни на газ.")


def test_vad_regions_cut_long_pauses_and_pad():
    # 0.03 s frames: speech 0-1 s, pause 0.3 s (kept), speech, pause 2 s (cut), speech
    f = [True] * 33 + [False] * 10 + [True] * 20 + [False] * 66 + [True] * 10
    regions = media.regions_from_flags(f, 0.03, pad=0.1, max_pause=0.8, total=len(f) * 0.03)
    assert len(regions) == 2
    assert regions[0][0] == 0.0 and abs(regions[0][1] - (63 * 0.03 + 0.1)) < 1e-6


def test_time_map_returns_original_video_time():
    tm = media.TimeMap([(10.0, 20.0), (50.0, 60.0)], speed=1.25)
    assert tm.original(0) == 10.0
    assert tm.original(4.0) == 15.0            # 4 s of 1.25x audio = 5 s of speech
    assert tm.original(10.0) == 52.5           # 12.5 s of speech: second region, 2.5 s in
    assert tm.original(1000) == 60.0           # clamped to the end of the last region


def test_whisper_json_and_body_timecodes():
    data = {"transcription": [{"offsets": {"from": 0, "to": 2000}, "text": " Привіт."},
                              {"offsets": {"from": 65000, "to": 67000}, "text": " Друга думка."}]}
    segs = media.parse_whisper_json(data)
    assert segs == [(0.0, "Привіт."), (65.0, "Друга думка.")]
    assert media.transcript_body(segs).splitlines()[-1] == "[01:05] Друга думка."
    assert media.fmt_tc(3725) == "1:02:05"


def test_budget_key_skips_lite_models(monkeypatch):
    monkeypatch.setenv("LLM_DAILY_LIMITS", "gemini-2.5-flash=20,gemini-3.6-flash=20")
    assert gemini.budget_key("gemini-2.5-flash") == "gemini-2.5-flash"
    assert gemini.budget_key("gemini-2.5-flash-preview-09") == "gemini-2.5-flash"
    assert gemini.budget_key("gemini-2.5-flash-lite") is None
    assert gemini.budget_key("gemini-3.5-flash-lite") is None


def test_sdmx_csv_split_by_area_and_periods():
    text = ("DATAFLOW,REF_AREA,FREQ,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n"
            "X,DEU,M,2026-01,3.9,A\nX,USA,M,2026-01,4.1,A\nX,DEU,M,2026-02,,A\n")
    assert sdmx.parse_sdmx_csv(text, "DEU") == [("2026-01", 3.9, "A"), ("2026-02", None, "A")]
    assert sdmx.norm_period("2026-M08") == "2026-08"
    assert sdmx.norm_period("2026-Q2") == "2026-Q2"
    assert sdmx.norm_period("2025") == "2025"


def test_firms_csv():
    text = ("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"
            "47.1,35.2,330,0.4,0.4,2026-11-17,0142,N,VIIRS,n,2.0NRT,290,12.5,N\n")
    rows = ukraine.parse_firms_csv(text, "VIIRS_SNPP_NRT")
    assert rows[0][1].isoformat() == "2026-11-17T01:42:00+00:00"
    assert rows[0][4] == 12.5 and rows[0][6] == "N"


def test_edr_subject():
    el = ET.fromstring(
        "<SUBJECT><NAME>ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ \"ТЕСТ\"</NAME><SHORT_NAME>ТОВ \"ТЕСТ\"</SHORT_NAME>"
        "<EDRPOU>12345678</EDRPOU><OPF>ТОВ</OPF><STAN>зареєстровано</STAN><AUTHORIZED_CAPITAL>1 000,50</AUTHORIZED_CAPITAL>"
        "<FOUNDERS><FOUNDER>Іваненко Іван</FOUNDER></FOUNDERS><BENEFICIARIES><BENEFICIARY>Петренко Петро</BENEFICIARY></BENEFICIARIES>"
        "</SUBJECT>")
    rec = ukraine.parse_edr_subject(el)
    assert rec["edrpou"] == "12345678" and rec["capital"] == 1000.5
    assert rec["founders"] == ["Іваненко Іван"] and rec["beneficiaries"] == ["Петренко Петро"]
    assert rec["terminated"] is False


def test_rtf_and_case_numbers():
    assert "Вирок" in ukraine.rtf_to_text(r"{\rtf1\ansi {\b \'c2\'e8\'f0\'ee\'ea}\par текст}")
    assert ukraine.CASE_RE.findall("у справі № 757/12345/26 та справа 991/100/25") == ["757/12345/26", "991/100/25"]


def test_decisions_client_budget_and_thresholds(monkeypatch):
    import contextlib
    from types import SimpleNamespace
    from kb.llm import decisions

    decisions.reset_for_tests()
    monkeypatch.setenv("GEMINI_API_KEY", "mock")
    locks = []
    rows = {}

    class Conn:
        def execute(self, sql, args):
            if "pg_advisory_xact_lock" in sql:
                locks.append(args[0])
            if sql.startswith("SELECT purpose"):
                day, model = args
                self.res = [{"purpose": p, "used": u} for (d, m, p), u in rows.items() if d == day and m == model]
            if sql.startswith("INSERT INTO llm_budget_days"):
                day, model, purpose, count = args
                rows[(day, model, purpose)] = rows.get((day, model, purpose), 0) + int(count)
            return self

        def fetchall(self):
            return self.res

    @contextlib.contextmanager
    def tx():
        yield Conn()

    monkeypatch.setattr(decisions.db, "tx", tx, raising=False)
    for _ in range(30):
        assert decisions.reserve("kb_categorize") is True
    assert len(locks) == 2
    assert sum(rows.values()) == 50

    def fake_post(url, json, headers, timeout):
        qkey = next(iter(json["questions"]))
        if qkey == "category":
            return SimpleNamespace(status_code=200, json=lambda: {"answers": {"category": {"choice": "finance", "confidence": 0.88}}, "usageMetadata": {"promptTokenCount": 120}})
        return SimpleNamespace(status_code=200, json=lambda: {"answers": {"cluster": {"choice": "new_event", "confidence": 0.91}}, "usageMetadata": {"promptTokenCount": 140}})

    monkeypatch.setattr(decisions.httpx, "post", fake_post)
    assert decisions.classify_category("Bank rate cut", "Central bank lowered rate", {"finance": "Фінанси", "other": "Інше"}) == ("finance", 0.88)
    assert decisions.classify_category("Bank rate cut", "Central bank lowered rate", {"finance": "Фінанси"}, min_confidence=0.95) is None
    assert decisions.arbitrate_cluster("New event", "Details", [{"id": 10, "title": "Old", "category": "finance", "hours": 4}]) == (None, 0.91)
    decisions.reset_for_tests()
