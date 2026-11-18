import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import yaml

from kb.connectors import statistics as st
from kb.connectors.base import ConnectorSkipped, REGISTRY


# Inline fixtures follow the response formats specified in CODEX_TASK_STATISTICS.md.
# No test contacts a provider or opens a database connection.
@pytest.mark.parametrize("payload,expected", [
    ([{"page": 1, "pages": 1}, [
        {"date": "2024", "value": 2.9, "obs_status": ""},
        {"date": "2023", "value": 0},
    ]], [("2023", 0.0, None), ("2024", 2.9, None)]),
    ([{}, [{"date": " 2024 ", "value": None, "obs_status": "p"}]], [("2024", None, "p")]),
    ([{}, None], []),
])
def test_worldbank(payload, expected):
    assert st.parse_worldbank(payload) == expected


@pytest.mark.parametrize("payload,expected", [
    ({"id": ["geo", "time"], "size": [1, 2], "dimension": {
        "geo": {"category": {"index": {"EA20": 0}}},
        "time": {"category": {"index": {"2024-09": 1, "2024M08": 0}}}},
      "value": {"0": 2.2, "1": 1.8}, "status": {"1": "p"}},
     [("2024-08", 2.2, None), ("2024-09", 1.8, "p")]),
    ({"id": ["time", "geo"], "size": [2, 1], "dimension": {
        "geo": {"category": {"index": {"EA20": 0}}},
        "time": {"category": {"index": {"2024Q3": 0, "2024-Q4": 1}}}},
      "value": {"0": 0}, "status": {"1": "u"}},
     [("2024-Q3", 0.0, None), ("2024-Q4", None, "u")]),
    ({"dimension": {"time": {"category": {"index": ["2024M09"]}}},
      "value": [None], "status": ["p"]}, [("2024-09", None, "p")]),
])
def test_eurostat(payload, expected):
    assert st.parse_eurostat(payload) == expected


def test_eurostat_rejects_multiple_series():
    with pytest.raises(ValueError, match="one series"):
        st.parse_eurostat({"id": ["geo", "time"], "size": [2, 1], "dimension": {
            "geo": {"category": {"index": {"PL": 0, "DE": 1}}},
            "time": {"category": {"index": {"2024M09": 0}}}}, "value": {"0": 1, "1": 2}})


@pytest.mark.parametrize("payload,expected", [
    ('KEY,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n"EXR,D",2024-09-30,1.12,A\n',
     [("2024-09-30", 1.12, "A")]),
    ('\ufeffTIME_PERIOD,OBS_VALUE,OBS_STATUS\r\n2024M09,,M\r\n2024Q3,0,P\r\n',
     [("2024-09", None, "M"), ("2024-Q3", 0.0, "P")]),
])
def test_ecb(payload, expected):
    assert st.parse_ecb(payload) == expected


@pytest.mark.parametrize("payload,expected", [
    ({"observations": [{"date": "2024-09-30", "value": "4.83"}]}, [("2024-09-30", 4.83, None)]),
    ({"observations": [{"date": "2024-09-01", "value": "."},
                       {"date": "2024-10-01", "value": "314.54"}]},
     [("2024-09-01", None, None), ("2024-10-01", 314.54, None)]),
])
def test_fred(payload, expected):
    assert st.parse_fred(payload) == expected


@pytest.mark.parametrize("payload,expected", [
    ({"response": {"data": [{"period": "2024-09-30", "value": "71.77"}]}},
     [("2024-09-30", 71.77, None)]),
    ({"response": {"data": [{"period": "2024Q3", "value": None},
                            {"period": "2024M09", "value": "0"}]}},
     [("2024-09", 0.0, None), ("2024-Q3", None, None)]),
])
def test_eia(payload, expected):
    assert st.parse_eia(payload) == expected


@pytest.mark.parametrize("payload,expected", [
    ({"items": [{"year": 2024, "refugees": 100, "asylum_seekers": 10, "coa_iso": "POL"},
                {"year": 2024, "refugees": "200", "asylum_seekers": 20, "coa_iso": "DEU"}]},
     [("2024", 300.0, None)]),
    ({"items": [{"year": " 2023 ", "refugees": None}, {"year": 2024, "refugees": 0}]},
     [("2023", None, None), ("2024", 0.0, None)]),
])
def test_unhcr(payload, expected):
    assert st.parse_unhcr(payload) == expected


def test_unhcr_value_field():
    assert st.parse_unhcr({"items": [{"year": 2024, "refugees": 10, "asylum_seekers": 2}]},
                         value_field="asylum_seekers") == [("2024", 2.0, None)]


@pytest.mark.parametrize("payload,expected", [
    ({"data": [{"Year": 2024, "Value": 22000000, "Flag": "A"}]}, [("2024", 22000000.0, "A")]),
    ({"data": [{"Year": " 2023 ", "Value": None, "Flag": "M"},
               {"Year": "2024", "Value": "0", "Flag": "E"}]},
     [("2023", None, "M"), ("2024", 0.0, "E")]),
])
def test_faostat(payload, expected):
    assert st.parse_faostat(payload) == expected


@pytest.mark.parametrize("payload,expected", [
    ([{"r030": 840, "txt": "US dollar", "rate": 41.5, "cc": "USD", "exchangedate": "18.11.2026"}],
     [("2026-11-18", 41.5, None)]),
    ([{"rate": None, "cc": "EUR", "exchangedate": "20261118"}], [("2026-11-18", None, None)]),
])
def test_nbu_exchange(payload, expected):
    assert st.parse_nbu_exchange(payload) == expected


@pytest.mark.parametrize("payload,expected", [
    ([{"startdate": "18.11.2026", "value": 15.5}], [("2026-11-18", 15.5, None)]),
    ([{"dt": "20261118", "value": None}], [("2026-11-18", None, None)]),
    ([{"startdate": "", "dt": "20261118", "value": "0"}], [("2026-11-18", 0.0, None)]),
])
def test_nbu_key_rate(payload, expected):
    assert st.parse_nbu_key_rate(payload) == expected


@pytest.mark.parametrize("parser,payload", [
    (st.parse_ecb, "TIME_PERIOD,OBS_VALUE\n2024-13,1\n"),
    (st.parse_ecb, "error\nmessage\n"),
    (st.parse_worldbank, [{"message": [{"id": "120", "value": "Invalid value"}]}]),
    (st.parse_nbu_exchange, [{"exchangedate": "31.02.2024", "rate": 1}]),
    (st.parse_faostat, {"data": [{"Year": "unknown", "Value": 1}]}),
])
def test_invalid_payloads_fail_instead_of_storing_bad_periods(parser, payload):
    with pytest.raises(ValueError):
        parser(payload)


def test_catalog():
    data = yaml.safe_load(st.CATALOG.read_text(encoding="utf-8"))
    taxonomy = yaml.safe_load((st.CATALOG.parent / "taxonomy.yaml").read_text(encoding="utf-8"))["categories"]
    assert data["version"] == 1
    assert 80 <= len(data["series"]) <= 120
    required = {"provider", "code", "geo", "title", "title_uk", "unit", "frequency", "categories", "keywords"}
    identities = set()
    providers = set()
    for row in data["series"]:
        assert required <= row.keys()
        identity = row["provider"], row["code"]
        assert identity not in identities
        identities.add(identity)
        providers.add(row["provider"])
        assert row["frequency"] in {"A", "Q", "M", "W", "D"}
        assert row["categories"] and set(row["categories"]) <= taxonomy.keys()
        assert row["keywords"] and all(isinstance(k, str) and k for k in row["keywords"])
        assert row["title"] and row["unit"]
        assert any("\u0400" <= char <= "\u04ff" for char in row["title_uk"])
        assert "?" not in row["title_uk"]
        assert len(row["geo"]) == 3 or row["geo"] == "EA20"
        assert st._source(row["provider"], row).startswith("https://")
    assert providers == set(st.LICENSES)
    wb = [r for r in data["series"] if r["provider"] == "worldbank"]
    for geo in {"UKR", "RUS", "POL", "DEU", "FRA", "GBR", "USA", "CHN", "TUR", "MDA"}:
        assert len([r for r in wb if r["geo"] == geo]) >= 8


@pytest.mark.parametrize("provider,hours,env", [
    ("worldbank", 168, None), ("eurostat", 12, None), ("ecb", 6, None),
    ("fred", 12, "FRED_API_KEY"), ("eia", 12, "EIA_API_KEY"),
    ("unhcr", 168, None), ("faostat", 168, None), ("nbu", 6, None),
])
def test_registered_connectors(provider, hours, env):
    cls = REGISTRY[provider]
    assert issubclass(cls, st.Connector)
    assert cls.interval_s == hours * 3600
    assert cls.requires_env == env


@pytest.fixture
def storage(monkeypatch):
    """A failure to mock any HTTP call must fail locally, never reach a host."""
    monkeypatch.setattr(st, "get", Mock(side_effect=AssertionError("Unexpected HTTP")))
    monkeypatch.setattr(st, "get_json", Mock(side_effect=AssertionError("Unexpected HTTP")))
    monkeypatch.setattr(st, "_today", lambda: date(2026, 11, 18))
    series = Mock(return_value=17)
    observations = Mock(return_value={"new": 1, "revised": 2})
    monkeypatch.setattr(st, "upsert_series", series)
    monkeypatch.setattr(st, "upsert_observations", observations)
    monkeypatch.setattr(st.db, "fetch_one", Mock(return_value={"last_period": None}))
    monkeypatch.setattr(st.db, "fetch_all", Mock(return_value=[]))
    return series, observations


def _entry(provider, code=None):
    return next(row for row in yaml.safe_load(st.CATALOG.read_text(encoding="utf-8"))["series"]
                if row["provider"] == provider and (code is None or row["code"] == code))


def _catalog(tmp_path, monkeypatch, entries):
    catalog = tmp_path / "series.yaml"
    catalog.write_text(yaml.safe_dump({"version": 1, "series": entries}), encoding="utf-8")
    monkeypatch.setattr(st, "CATALOG", catalog)


@pytest.mark.parametrize("provider,code,payload,expected", [
    ("worldbank", None, [{"pages": 1}, [{"date": "2024", "value": 2}]], ("2024", 2.0, None)),
    ("eurostat", None, {"dimension": {"time": {"category": {"index": {"2024M09": 0}}}},
                        "value": {"0": 2}}, ("2024-09", 2.0, None)),
    ("ecb", None, "TIME_PERIOD,OBS_VALUE,OBS_STATUS\n2024-09-30,2,A\n", ("2024-09-30", 2.0, "A")),
    ("fred", "CPIAUCSL", {"observations": [{"date": "2024-09-01", "value": "314.54"}]},
     ("2024-09", 314.54, None)),
    ("eia", None, {"response": {"data": [{"period": "2024-09-30", "value": 2}]}},
     ("2024-09-30", 2.0, None)),
    ("unhcr", None, {"items": [{"year": 2024, "refugees": 2}]}, ("2024", 2.0, None)),
    ("faostat", None, {"data": [{"Year": 2024, "Value": 2, "Flag": "A"}]}, ("2024", 2.0, "A")),
    ("nbu", "key_rate", [{"startdate": "18.11.2026", "value": 2}], ("2026-11-18", 2.0, None)),
])
def test_run_each_provider(provider, code, payload, expected, storage, monkeypatch, tmp_path):
    entry = _entry(provider, code)
    _catalog(tmp_path, monkeypatch, [entry])
    monkeypatch.setenv("FRED_API_KEY", "test-fred")
    monkeypatch.setenv("EIA_API_KEY", "test-eia")
    monkeypatch.setattr(st, "get_json", Mock(return_value=payload))
    monkeypatch.setattr(st, "get", Mock(return_value=SimpleNamespace(text=payload)))
    connector = REGISTRY[provider]()
    cursor = {"keep": True}
    assert connector.run(cursor) is cursor
    series, observations = storage
    assert series.call_args.args == (provider, entry["code"], entry["title"], entry["frequency"])
    assert series.call_args.kwargs["license"] == st.LICENSES[provider]
    assert series.call_args.kwargs["geo"] == ("EMU" if entry["geo"] == "EA20" else entry["geo"])
    assert series.call_args.kwargs["categories"] == entry["categories"]
    observations.assert_called_once_with(17, [expected])
    assert connector.stats == {"series": 1, "new": 1, "revised": 2}


@pytest.mark.parametrize("provider,env", [("fred", "FRED_API_KEY"), ("eia", "EIA_API_KEY")])
def test_missing_key_skips(provider, env, storage, monkeypatch):
    monkeypatch.delenv(env, raising=False)
    with pytest.raises(ConnectorSkipped, match=env):
        REGISTRY[provider]().run({})
    storage[0].assert_not_called()


@pytest.mark.parametrize("failure", ["fetch", "metadata", "observations"])
def test_one_failed_series_does_not_stop_others(failure, storage, monkeypatch, tmp_path, caplog):
    entries = [_entry("fred", "DFF"), _entry("fred", "UNRATE")]
    _catalog(tmp_path, monkeypatch, entries)
    monkeypatch.setenv("FRED_API_KEY", "secret-key")
    monkeypatch.setattr(st, "get_json", Mock(return_value={"observations": [{"date": "2024-09-01", "value": "1"}]}))
    if failure == "fetch":
        st.get_json.side_effect = [RuntimeError("URL?api_key=secret-key"), {"observations": []}]
    elif failure == "metadata":
        storage[0].side_effect = [RuntimeError("database failure"), 17]
    else:
        storage[1].side_effect = [RuntimeError("database failure"), {"new": 0, "revised": 0}]
    connector = st.FRED()
    connector.run({})
    assert connector.stats["errors"] == 1
    assert storage[0].call_count == 2
    assert "Statistics series failed" in caplog.text
    assert "secret-key" not in caplog.text


def test_revision_window(storage, monkeypatch):
    assert st._start(None) == "2024-11-18"
    assert st._start("2026-11-18") == "2026-09-19"
    assert st._start("2024-09") == "2024-07-03"
    assert st._start("2024-Q3") == "2024-05-02"
    assert st._start("2024") == "2023-11-02"
    monkeypatch.setattr(st, "_today", lambda: date(2024, 2, 29))
    assert st._start(None) == "2022-02-28"


def test_fred_requests_since_last_period(storage, monkeypatch):
    monkeypatch.setenv("FRED_API_KEY", "key")
    response = Mock(return_value={"observations": []})
    monkeypatch.setattr(st, "get_json", response)
    st.FRED().fetch(_entry("fred", "DFF"), 17, "2026-11-18")
    params = response.call_args.kwargs["params"]
    assert params["observation_start"] == "2026-09-19"
    assert params["series_id"] == "DFF"
    assert params["api_key"] == "key"


def test_worldbank_country_identity_and_pagination(storage, monkeypatch):
    request = Mock(side_effect=[
        [{"pages": 2}, [{"date": "2024", "value": 2}]],
        [{"pages": 2}, [{"date": "2023", "value": 1}]],
    ])
    monkeypatch.setattr(st, "get_json", request)
    rows = st.WorldBank().fetch(_entry("worldbank"), 17, "2024")
    assert rows == [("2023", 1.0, None), ("2024", 2.0, None)]
    assert request.call_count == 2
    assert request.call_args.args[0].endswith("/country/UKR/indicator/NY.GDP.MKTP.CD")
    assert request.call_args.kwargs["params"]["date"] == "2022:2027"
    assert request.call_args.kwargs["params"]["page"] == 2


def test_eurostat_filters(storage, monkeypatch):
    request = Mock(return_value={"dimension": {"time": {"category": {"index": {}}}}, "value": {}})
    monkeypatch.setattr(st, "get_json", request)
    st.Eurostat().fetch(_entry("eurostat"), 17, None)
    params = request.call_args.kwargs["params"]
    assert params["geo"] == "EA20" and params["coicop"] == "CP00"
    assert params["sinceTimePeriod"] == "2015"


def test_eia_pagination(storage, monkeypatch):
    monkeypatch.setenv("EIA_API_KEY", "key")
    request = Mock(side_effect=[
        {"response": {"total": "2", "data": [{"period": "2024-09-29", "value": 1}]}},
        {"response": {"total": "2", "data": [{"period": "2024-09-30", "value": 2}]}},
    ])
    monkeypatch.setattr(st, "get_json", request)
    assert len(st.EIA().fetch(_entry("eia"), 17, None)) == 2
    assert [c.kwargs["params"]["offset"] for c in request.call_args_list] == [0, 1]
    assert request.call_args.kwargs["params"]["facets[series][]"] == "RBRTE"


def test_unhcr_pagination_and_destination(storage, monkeypatch):
    request = Mock(side_effect=[
        {"maxPages": 2, "items": [{"year": 2024, "refugees": 1}]},
        {"maxPages": 2, "items": [{"year": 2024, "refugees": 2}]},
    ])
    monkeypatch.setattr(st, "get_json", request)
    entry = _entry("unhcr", "refugees:coo=UKR:coa=POL")
    assert st.UNHCR().fetch(entry, 17, None) == [("2024", 3.0, None)]
    assert request.call_args.kwargs["params"]["coa"] == "POL"
    assert request.call_args.kwargs["params"]["coo"] == "UKR"
    assert request.call_args.kwargs["params"]["page"] == 2


def test_nbu_only_fetches_missing_days_and_caps_requests(storage, monkeypatch):
    today = date(2026, 11, 18)
    # Missing dates inside stored history must also be fetched.
    st.db.fetch_all.return_value = [{"period": today.isoformat()},
                                   {"period": (today - timedelta(days=2)).isoformat()}]
    def response(url, params):
        return [{"exchangedate": params["date"], "rate": 41.5}]
    request = Mock(side_effect=response)
    monkeypatch.setattr(st, "get_json", request)
    connector = st.NBU()
    rows = connector.fetch(_entry("nbu", "exchange:USD"), 17, today.isoformat())
    dates = {c.kwargs["params"]["date"] for c in request.call_args_list}
    assert "20261118" not in dates and "20261116" not in dates
    assert "20261117" in dates
    assert len(rows) == 8
    connector.fetch(_entry("nbu", "exchange:EUR"), 18, None)
    assert request.call_count == 10


def test_nbu_stored_dates_make_no_requests(storage, monkeypatch):
    st.db.fetch_all.return_value = [
        {"period": (date(2026, 11, 18) - timedelta(days=i)).isoformat()} for i in range(10)]
    request = Mock(side_effect=AssertionError("Stored dates must not be fetched"))
    monkeypatch.setattr(st, "get_json", request)
    assert st.NBU().fetch(_entry("nbu", "exchange:USD"), 17, "2026-11-18") == []
    request.assert_not_called()


def test_older_gap_preserves_latest_stored_period(storage, monkeypatch, tmp_path):
    _catalog(tmp_path, monkeypatch, [_entry("nbu", "exchange:USD")])
    st.db.fetch_one.side_effect = [
        {"last_period": "2026-11-18"},
        {"period": "2026-11-18", "value": 41.5, "status": None},
    ]
    monkeypatch.setattr(st.NBU, "fetch", Mock(return_value=[("2026-11-17", 41.4, None)]))
    st.NBU().run({})
    storage[1].assert_called_once_with(17, [
        ("2026-11-17", 41.4, None), ("2026-11-18", 41.5, None),
    ])
