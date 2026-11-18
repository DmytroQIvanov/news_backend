import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from dataclasses import FrozenInstanceError
from datetime import date, datetime

import pytest

from kb.text.temporal import TimeExpr, extract_time_expressions


REF = datetime(2026, 11, 17)


@pytest.mark.parametrize("lang,text,first,last,granularity", [
    ("uk", "2026-12-12", "2026-12-12", "2026-12-12", "day"),
    ("uk", "12.12.2026", "2026-12-12", "2026-12-12", "day"),
    ("de", "12/11/2026", "2026-11-12", "2026-11-12", "day"),
    ("en", "12/11/2026", "2026-12-11", "2026-12-11", "day"),
    ("en", "17/11/2026", "2026-11-17", "2026-11-17", "day"),
    ("uk", "12 грудня", "2026-12-12", "2026-12-12", "day"),
    ("uk", "12 грудня 2026 року", "2026-12-12", "2026-12-12", "day"),
    ("uk", "12 січня", "2027-01-12", "2027-01-12", "day"),
    ("en", "December 12", "2026-12-12", "2026-12-12", "day"),
    ("en", "December 12th, 2026", "2026-12-12", "2026-12-12", "day"),
    ("en", "12 December 2026", "2026-12-12", "2026-12-12", "day"),
    ("de", "12. Dezember 2026", "2026-12-12", "2026-12-12", "day"),
    ("ru", "12 декабря 2026 года", "2026-12-12", "2026-12-12", "day"),
    ("uk", "у грудні 2026", "2026-12-01", "2026-12-31", "month"),
    ("en", "December 2026", "2026-12-01", "2026-12-31", "month"),
    ("de", "im Dezember 2026", "2026-12-01", "2026-12-31", "month"),
    ("uk", "у березні", "2027-03-01", "2027-03-31", "month"),
    ("en", "in March", "2027-03-01", "2027-03-31", "month"),
    ("uk", "у 2025 році", "2025-01-01", "2025-12-31", "year"),
    ("en", "in 2025", "2025-01-01", "2025-12-31", "year"),
    ("uk", "2025 року", "2025-01-01", "2025-12-31", "year"),
    ("de", "im Jahr 2025", "2025-01-01", "2025-12-31", "year"),
    ("en", "Q3 2026", "2026-07-01", "2026-09-30", "quarter"),
    ("en", "third quarter", "2026-07-01", "2026-09-30", "quarter"),
    ("uk", "у третьому кварталі", "2026-07-01", "2026-09-30", "quarter"),
    ("uk", "в першому півріччі 2026", "2026-01-01", "2026-06-30", "quarter"),
    ("en", "H1 2026", "2026-01-01", "2026-06-30", "quarter"),
    ("en", "H2 2026", "2026-07-01", "2026-12-31", "quarter"),
    ("de", "im dritten Quartal 2026", "2026-07-01", "2026-09-30", "quarter"),
    ("uk", "сьогодні", "2026-11-17", "2026-11-17", "day"),
    ("uk", "вчора", "2026-11-16", "2026-11-16", "day"),
    ("uk", "учора", "2026-11-16", "2026-11-16", "day"),
    ("uk", "завтра", "2026-11-18", "2026-11-18", "day"),
    ("uk", "позавчора", "2026-11-15", "2026-11-15", "day"),
    ("en", "today", "2026-11-17", "2026-11-17", "day"),
    ("en", "yesterday", "2026-11-16", "2026-11-16", "day"),
    ("en", "tomorrow", "2026-11-18", "2026-11-18", "day"),
    ("en", "day before yesterday", "2026-11-15", "2026-11-15", "day"),
    ("de", "heute", "2026-11-17", "2026-11-17", "day"),
    ("de", "gestern", "2026-11-16", "2026-11-16", "day"),
    ("de", "morgen", "2026-11-18", "2026-11-18", "day"),
    ("uk", "минулого тижня", "2026-11-09", "2026-11-15", "week"),
    ("uk", "наступного місяця", "2026-12-01", "2026-12-31", "month"),
    ("uk", "цього року", "2026-01-01", "2026-12-31", "year"),
    ("uk", "торік", "2025-01-01", "2025-12-31", "year"),
    ("uk", "наступного року", "2027-01-01", "2027-12-31", "year"),
    ("en", "last week", "2026-11-09", "2026-11-15", "week"),
    ("en", "next month", "2026-12-01", "2026-12-31", "month"),
    ("en", "this year", "2026-01-01", "2026-12-31", "year"),
    ("de", "letzte Woche", "2026-11-09", "2026-11-15", "week"),
    ("de", "nächsten Monat", "2026-12-01", "2026-12-31", "month"),
    ("de", "dieses Jahr", "2026-01-01", "2026-12-31", "year"),
    ("en", "3 days ago", "2026-11-14", "2026-11-14", "day"),
    ("en", "2 weeks ago", "2026-11-02", "2026-11-08", "week"),
    ("en", "2 months ago", "2026-09-01", "2026-09-30", "month"),
    ("en", "2 years ago", "2024-01-01", "2024-12-31", "year"),
    ("uk", "через 5 днів", "2026-11-22", "2026-11-22", "day"),
    ("uk", "через 2 тижні", "2026-11-30", "2026-12-06", "week"),
    ("uk", "через 2 місяці", "2027-01-01", "2027-01-31", "month"),
    ("uk", "через 2 роки", "2028-01-01", "2028-12-31", "year"),
    ("uk", "3 дні тому", "2026-11-14", "2026-11-14", "day"),
    ("uk", "за останні 7 днів", "2026-11-11", "2026-11-17", "day"),
    ("en", "over the last 7 days", "2026-11-11", "2026-11-17", "day"),
    ("de", "vor 3 Tagen", "2026-11-14", "2026-11-14", "day"),
    ("de", "in 2 Monaten", "2027-01-01", "2027-01-31", "month"),
    ("uk", "у понеділок", "2026-11-16", "2026-11-16", "day"),
    ("uk", "у п'ятницю", "2026-11-13", "2026-11-13", "day"),
    ("uk", "у п’ятницю", "2026-11-13", "2026-11-13", "day"),
    ("en", "next Monday", "2026-11-23", "2026-11-23", "day"),
    ("en", "Tuesday", "2026-11-10", "2026-11-10", "day"),
    ("de", "am Montag", "2026-11-16", "2026-11-16", "day"),
    ("en", "2010s", "2010-01-01", "2019-12-31", "decade"),
    ("uk", "у 2010-х", "2010-01-01", "2019-12-31", "decade"),
])
def test_calendar_expressions(lang, text, first, last, granularity):
    result = extract_time_expressions(text, lang, REF)
    assert len(result) == 1
    item = result[0]
    assert (item.value_start, item.value_end) == (date.fromisoformat(first), date.fromisoformat(last))
    assert item.granularity == granularity
    assert item.text == text
    assert (item.start, item.end) == (0, len(text))
    expected_direction = "past" if item.value_end < REF.date() else "future" if item.value_start > REF.date() else "present"
    assert item.direction == expected_direction


@pytest.mark.parametrize("month,forms", [
    (1, "січень січня січні січню січнем"), (2, "лютий лютого лютому лютім лютим"),
    (3, "березень березня березні березню березнем"), (4, "квітень квітня квітні квітню квітнем"),
    (5, "травень травня травні травню травнем"), (6, "червень червня червні червню червнем"),
    (7, "липень липня липні липню липнем"), (8, "серпень серпня серпні серпню серпнем"),
    (9, "вересень вересня вересні вересню вереснем"), (10, "жовтень жовтня жовтні жовтню жовтнем"),
    (11, "листопад листопада листопаді листопаду листопадом"), (12, "грудень грудня грудні грудню груднем"),
])
def test_all_ukrainian_month_cases(month, forms):
    for form in forms.split():
        items = extract_time_expressions(f"у {form} 2026", "uk", REF)
        assert len(items) == 1
        assert items[0].value_start == date(2026, month, 1)


@pytest.mark.parametrize("lang,text", [
    ("en", "2025 people, Windows 11, iPhone 17, COVID-19, GPT-5"),
    ("uk", "+380 (67) 123-45-67 та 2026 людей"),
    ("de", "+49 30 123456, 2025 Menschen"),
    ("en", "2026-02-30 2026-13-01 31/02/2026 00.12.2026"),
    ("en", "12026-12-12 12.12.20260 x2026-12-12"),
    ("uk", "несьогодні післязавтрами"),
    ("en", "31 February 2026; February 31, 2026; 32 December 2026"),
    ("uk", "31 лютого 2026 року"),
    ("de", "31. Februar 2026"),
])
def test_no_false_positives(lang, text):
    assert extract_time_expressions(text, lang, REF) == []


def test_offsets_order_and_longest_match():
    text = "Новина: 12 грудня 2026 року, а вчора — 16 листопада."
    items = extract_time_expressions(text, "uk", REF)
    assert [item.text for item in items] == ["12 грудня 2026 року", "вчора", "16 листопада"]
    for item in items:
        assert text[item.start:item.end] == item.text
    assert all(a.end <= b.start for a, b in zip(items, items[1:]))
    assert items[0].relative is False
    assert items[1].relative is True
    assert items[2].relative is True


@pytest.mark.parametrize("text,lang,ref", [
    (None, "en", REF), (b"today", "en", REF), (123, "en", REF),
    ("today", None, REF), ("today", "xx", REF), ("today", "en", None),
    ("", "en", REF), ("999999999999999999999 years ago", "en", REF),
    ("tomorrow", "en", date.max), ("yesterday", "en", date.min),
])
def test_odd_input(text, lang, ref):
    assert extract_time_expressions(text, lang, ref) == []


def test_calendar_boundaries_and_frozen_record():
    assert extract_time_expressions("next month", "en", date(2026, 12, 31))[0].value_end == date(2027, 1, 31)
    assert extract_time_expressions("1 month ago", "en", date(2024, 3, 31))[0].value_end == date(2024, 2, 29)
    assert extract_time_expressions("29 February", "en", REF)[0].value_start == date(2028, 2, 29)
    item = extract_time_expressions("TODAY", "en-US", REF.date())[0]
    assert isinstance(item, TimeExpr)
    with pytest.raises(FrozenInstanceError):
        item.start = 1


def test_invalid_date_does_not_hide_separate_valid_expression():
    items = extract_time_expressions("31 February 2026, then tomorrow", "en", REF)
    assert [item.text for item in items] == ["tomorrow"]
