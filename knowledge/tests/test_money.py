import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from dataclasses import FrozenInstanceError

import pytest

from kb.text.money import MoneyExpr, QuantityExpr, extract_money, extract_quantities, parse_number


@pytest.mark.parametrize("lang,text,amount,currency,qualifier", [
    ("en", "$1.2 billion", 1.2e9, "USD", None),
    ("en", "$1.2bn", 1.2e9, "USD", None),
    ("en", "$500M", 5e8, "USD", None),
    ("en", "US$ 3 trln", 3e12, "USD", None),
    ("en", "€40 million", 4e7, "EUR", None),
    ("en", "£2.5bn", 2.5e9, "GBP", None),
    ("uk", "1,2 млрд доларів", 1.2e9, "USD", None),
    ("uk", "1,2 млрд дол.", 1.2e9, "USD", None),
    ("uk", "500 млн грн", 5e8, "UAH", None),
    ("uk", "3 трлн гривень", 3e12, "UAH", None),
    ("uk", "2 млн євро", 2e6, "EUR", None),
    ("uk", "40 тис. доларів США", 4e4, "USD", None),
    ("uk", "$40 тис.", 4e4, "USD", None),
    ("de", "1.5 Mrd. Euro", 1.5e9, "EUR", None),
    ("de", "300 Millionen Dollar", 3e8, "USD", None),
    ("de", "2 Billionen Euro", 2e12, "EUR", None),
    ("de", "eine Zahlung: 1 Billion Euro", 1e12, "EUR", None),
    ("en", "¥10 billion", 1e10, "JPY", None),
    ("uk", "10 млрд юанів", 1e10, "CNY", None),
    ("uk", "5 млрд рублів", 5e9, "RUB", None),
    ("uk", "понад 2 млрд доларів", 2e9, "USD", "over"),
    ("uk", "близько $3 млрд", 3e9, "USD", "about"),
    ("en", "up to $10bn", 1e10, "USD", "up_to"),
    ("en", "under $1 billion", 1e9, "USD", "under"),
    ("uk", "майже 2 мільйони гривень", 2e6, "UAH", "under"),
    ("de", "rund 1.200 Euro", 1200, "EUR", "about"),
    ("de", "mehr als 3 Mrd. Euro", 3e9, "EUR", "over"),
    ("en", "~$40", 40, "USD", "about"),
    ("en", "100 PLN", 100, "PLN", None),
    ("en", "500 CHF", 500, "CHF", None),
    ("uk", "1\u00a0200\u00a0000 грн", 1.2e6, "UAH", None),
    ("en", "USD 1,200.50", 1200.5, "USD", None),
    ("de", "1.200,50 EUR", 1200.5, "EUR", None),
    ("en", "C$10 million", 1e7, "CAD", None),
    ("en", "CN¥10 billion", 1e10, "CNY", None),
])
def test_money_examples(lang, text, amount, currency, qualifier):
    items = extract_money(text, lang)
    assert len(items) == 1
    item = items[0]
    assert item.amount == pytest.approx(amount)
    assert item.currency == currency
    assert item.qualifier == qualifier
    assert item.approximate is (qualifier is not None)
    expected = "1 Billion Euro" if text.startswith("eine Zahlung") else text
    assert item.text == expected
    assert text[item.start:item.end] == expected


@pytest.mark.parametrize("lang,token,value", [
    ("uk", "1,2", 1.2), ("en", "1.2", 1.2), ("uk", "1 200", 1200),
    ("en", "1,200", 1200), ("de", "1.200", 1200), ("de", "1.5", 1.5),
    ("de", "1.200.000", 1.2e6), ("en", "1,200,000", 1.2e6),
    ("uk", "1\u202f200,25", 1200.25), ("en", "1,234.56", 1234.56),
    ("de", "1.234,56", 1234.56), ("fr", "1 234,56", 1234.56),
    ("en", " -12.5 ", -12.5), ("de", "+12,5", 12.5), ("uk", "0", 0),
])
def test_parse_number(lang, token, value):
    assert parse_number(token, lang) == pytest.approx(value)


@pytest.mark.parametrize("token", [None, 42, "", "NaN", "inf", "1e9", "12 34", "1,2,3", "1..2", "1.23.456", "1,23.45", "-", "9" * 400])
def test_invalid_number(token):
    assert parse_number(token, "en") is None


@pytest.mark.parametrize("scale,value", [
    ("тис.", 1e3), ("тисяча", 1e3), ("тисячі", 1e3), ("тисяч", 1e3),
    ("млн", 1e6), ("мільйон", 1e6), ("мільйона", 1e6), ("мільйонів", 1e6),
    ("млрд", 1e9), ("мільярд", 1e9), ("мільярда", 1e9), ("мільярдів", 1e9),
    ("трлн", 1e12), ("трильйон", 1e12), ("трильйона", 1e12), ("трильйонів", 1e12),
])
def test_ukrainian_scale_cases(scale, value):
    assert extract_money(f"2 {scale} грн", "uk")[0].amount == 2 * value


@pytest.mark.parametrize("lang,text,value,unit,approximate", [
    ("en", "15%", 15, "percent", False),
    ("uk", "15 відсотків", 15, "percent", False),
    ("en", "15 percent", 15, "percent", False),
    ("de", "15 Prozent", 15, "percent", False),
    ("uk", "загинули 12 людей", 12, "people", False),
    ("en", "12 people killed", 12, "people", False),
    ("uk", "понад 1000 осіб", 1000, "people", True),
    ("en", "about 1.2 million people", 1.2e6, "people", True),
    ("uk", "500 МВт", 500, "mw", False),
    ("en", "2 GW", 2, "gw", False),
    ("uk", "5 млрд кубометрів", 5, "bcm", False),
    ("en", "5 bcm", 5, "bcm", False),
    ("en", "500 million cubic metres", 0.5, "bcm", False),
    ("en", "10 billion cubic meters", 10, "bcm", False),
    ("en", "2 million barrels per day", 2e6, "barrels", False),
    ("uk", "200 тисяч барелів на добу", 2e5, "barrels", False),
    ("uk", "15 млн тонн", 15e6, "tonnes", False),
    ("en", "30 tonnes", 30, "tonnes", False),
    ("en", "30 tons", 30, "tonnes", False),
    ("de", "30 Tonnen", 30, "tonnes", False),
    ("uk", "40 км", 40, "km", False),
    ("en", "500 units", 500, "units", False),
])
def test_quantities(lang, text, value, unit, approximate):
    items = extract_quantities(text, lang)
    assert len(items) == 1
    item = items[0]
    assert isinstance(item, QuantityExpr)
    assert (item.unit, item.approximate) == (unit, approximate)
    assert item.value == pytest.approx(value)
    assert text[item.start:item.end] == item.text
    if unit == "barrels":
        assert item.text.endswith(("per day", "на добу"))


@pytest.mark.parametrize("text", [None, b"$5", 45, "", "2026 GPT-5 COVID-19 Windows 11 iPhone 17", "+380 67 123 45 67", "USDfoo 30", "30 dollarsworth"])
def test_odd_input_and_false_positives(text):
    assert extract_money(text, "en") == []
    assert extract_quantities(text, "en") == []


def test_offsets_order_and_immutable_money():
    text = "Budget: about $3bn, then €40 million, with 15% growth."
    items = extract_money(text, "en")
    assert [item.text for item in items] == ["about $3bn", "€40 million"]
    assert all(text[item.start:item.end] == item.text for item in items)
    assert isinstance(items[0], MoneyExpr)
    assert items[0].end < items[1].start
    with pytest.raises(FrozenInstanceError):
        items[0].amount = 0
    assert extract_money("$5", None) == []
    assert extract_quantities("5%", None) == []


def test_taxonomy_structure_and_terms():
    import yaml

    path = pathlib.Path(__file__).resolve().parents[1] / "kb/resources/taxonomy.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    expected = "politics law economy finance career health psychology culture defense cybersecurity science_space hardware_gaming startups_fintech education_grants global_tech model api coding open_source research business climate_energy robotics crypto_web3 mobility_ev biotech ai_policy media_social sports travel_lifestyle real_estate".split()
    assert data["version"] == 1
    assert set(data["categories"]) == set(expected)
    for category in data["categories"].values():
        assert category["label_uk"]
        for strength in ("strong", "weak"):
            assert set(category[strength]) == {"uk", "en", "de"}
            for lang, terms in category[strength].items():
                assert (5 <= len(terms) <= 30) if lang == "de" else (10 <= len(terms) <= 72)
                assert len({term.casefold() for term in terms}) == len(terms)
                assert all(isinstance(term, str) and term.strip() == term and term and "*" not in term[:-1] for term in terms)
        for lang in ("uk", "en", "de"):
            assert not ({term.casefold() for term in category["strong"][lang]} & {term.casefold() for term in category["weak"][lang]})
