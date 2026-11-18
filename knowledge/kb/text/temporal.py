"""Deterministic news-date extraction, using calendar dates and source offsets.

Weeks start on Monday. Omitted years use the nearest valid calendar period;
unqualified weekdays mean the strictly previous occurrence. Half-years use
``quarter`` granularity (the public vocabulary has no half-year value).
"""

import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta


@dataclass(frozen=True)
class TimeExpr:
    text: str
    start: int
    end: int
    value_start: date | None
    value_end: date | None
    granularity: str
    relative: bool
    direction: str


_MONTH_NAMES = {
    "en": (
        "January", "February", "March", "April", "May", "June", "July",
        "August", "September", "October", "November", "December",
    ),
    "de": (
        "Januar", "Februar", "März|Maerz", "April", "Mai", "Juni", "Juli",
        "August", "September", "Oktober", "November", "Dezember",
    ),
    "uk": (
        "січень|січня|січні|січню|січнем", "лютий|лютого|лютому|лютім|лютим",
        "березень|березня|березні|березню|березнем", "квітень|квітня|квітні|квітню|квітнем",
        "травень|травня|травні|травню|травнем", "червень|червня|червні|червню|червнем",
        "липень|липня|липні|липню|липнем", "серпень|серпня|серпні|серпню|серпнем",
        "вересень|вересня|вересні|вересню|вереснем", "жовтень|жовтня|жовтні|жовтню|жовтнем",
        "листопад|листопада|листопаді|листопаду|листопадом", "грудень|грудня|грудні|грудню|груднем",
    ),
    "ru": (
        "январь|января|январе", "февраль|февраля|феврале", "март|марта|марте",
        "апрель|апреля|апреле", "май|мая|мае", "июнь|июня|июне", "июль|июля|июле",
        "август|августа|августе", "сентябрь|сентября|сентябре", "октябрь|октября|октябре",
        "ноябрь|ноября|ноябре", "декабрь|декабря|декабре",
    ),
}
_MONTHS = {
    lang: {name.casefold(): month for month, names in enumerate(groups, 1) for name in names.split("|")}
    for lang, groups in _MONTH_NAMES.items()
}
_PREFIX = {"en": r"(?:in|on)", "de": r"(?:im|in|am)", "uk": r"(?:у|в)", "ru": r"(?:в|во)"}
_YEAR_END = r"(?:\s+(?:року|році|рік|года|году|год|р\.))?"
_YEAR = r"[1-9]\d{3}"
_PATTERNS = {}
for _lang, _names in _MONTHS.items():
    _month = "(?:" + "|".join(sorted(map(re.escape, _names), key=len, reverse=True)) + ")"
    _prefix = rf"(?:{_PREFIX[_lang]}\s+)?"
    _PATTERNS[_lang] = [
        ("iso", re.compile(r"(?<![\w.+/-])(?P<y>" + _YEAR + r")-(?P<m>\d{2})-(?P<d>\d{2})(?![\w/-])", re.I)),
        ("numeric", re.compile(r"(?<![\w.+/-])(?P<a>\d{1,2})(?P<sep>[./])(?P<b>\d{1,2})(?P=sep)(?P<y>" + _YEAR + r")(?![\w./-])", re.I)),
        ("named", re.compile(rf"(?<!\w){_prefix}(?P<d>\d{{1,2}})\.?\s+(?P<m>{_month})(?:\s+(?P<y>{_YEAR}){_YEAR_END})?(?!\w)", re.I)),
        ("named", re.compile(rf"(?<!\w){_prefix}(?P<m>{_month})\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?(?!\d)(?:,?\s+(?P<y>{_YEAR}){_YEAR_END})?(?!\w)", re.I)),
        ("month", re.compile(rf"(?<!\w){_prefix}(?P<m>{_month})(?:\s+(?P<y>{_YEAR}){_YEAR_END})?(?!\w)", re.I)),
        ("year", re.compile(rf"(?<!\w)(?:{_PREFIX[_lang]}\s+(?:Jahr\s+)?(?P<y>{_YEAR}){_YEAR_END}|(?P<ys>{_YEAR})\s+(?:року|році|года|году|рік|год))(?!\w)", re.I)),
        ("decade", re.compile(rf"(?<!\w){_prefix}(?P<y>[1-9]\d{{2}}0)(?:s|[-–]х|[-–]ті|[-–]е|er)(?!\w)", re.I)),
    ]

_ORDINALS = {
    "en": ("first", "second", "third", "fourth"),
    "de": ("erste[nmrs]?", "zweite[nmrs]?", "dritte[nmrs]?", "vierte[nmrs]?"),
    "uk": ("перш(?:ий|ому|е|ім)", "друг(?:ий|ому|е|ім)", "трет(?:ій|ьому|є|ім)", "четверт(?:ий|ому|е|ім)"),
    "ru": ("перв(?:ый|ом|ое)", "втор(?:ой|ом|ое)", "трет(?:ий|ьем|ье)", "четверт(?:ый|ом|ое)"),
}
_QUARTER_WORD = {"en": "quarter", "de": "Quartal", "uk": "квартал(?:і|у)?", "ru": "квартал(?:е|а)?"}
_HALF_WORD = {"en": "half(?: of the year)?", "de": "Halbjahr", "uk": "піврічч(?:я|і)", "ru": "полугоди(?:е|и|я)"}
_ORDINAL_LOOKUP = {}
for _lang, _ord in _ORDINALS.items():
    _ORDINAL_LOOKUP[_lang] = [re.compile(rf"^(?:{word})$", re.I) for word in _ord]
    for _kind, _word in (("quarter", _QUARTER_WORD[_lang]), ("half", _HALF_WORD[_lang])):
        _PATTERNS[_lang].append((_kind, re.compile(
            rf"(?<!\w)(?:{_PREFIX[_lang]}\s+)?(?P<ord>{'|'.join(_ord[:2] if _kind == 'half' else _ord)})\s+{_word}(?:\s+(?P<y>{_YEAR}){_YEAR_END})?(?!\w)", re.I)))
    for _kind, _letter, _digits in (("quarter", "Q", "1-4"), ("half", "H", "12")):
        _PATTERNS[_lang].append((_kind, re.compile(rf"(?<!\w){_letter}(?P<n>[{_digits}])(?:\s+(?P<y>{_YEAR}){_YEAR_END})?(?!\w)", re.I)))

_DAY_WORDS = {
    "en": {"today": 0, "yesterday": -1, "tomorrow": 1, "day before yesterday": -2, "day after tomorrow": 2},
    "uk": {"сьогодні": 0, "вчора": -1, "учора": -1, "завтра": 1, "позавчора": -2, "післязавтра": 2},
    "de": {"heute": 0, "gestern": -1, "morgen": 1, "vorgestern": -2, "übermorgen": 2},
    "ru": {"сегодня": 0, "вчера": -1, "завтра": 1, "позавчера": -2, "послезавтра": 2},
}
_WEEKDAYS = {
    "en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
    "uk": ("понеділок", "вівторок", "середа|середу", "четвер", "п’ятниця|п’ятницю|п'ятниця|п'ятницю", "субота|суботу", "неділя|неділю"),
    "de": ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"),
    "ru": ("понедельник", "вторник", "среда|среду", "четверг", "пятница|пятницу", "суббота|субботу", "воскресенье"),
}
_UNITS = {
    "en": {"day": "day", "days": "day", "week": "week", "weeks": "week", "month": "month", "months": "month", "year": "year", "years": "year"},
    "uk": {**dict.fromkeys(("день", "дні", "днів", "дня"), "day"), **dict.fromkeys(("тиждень", "тижні", "тижнів", "тижня"), "week"), **dict.fromkeys(("місяць", "місяці", "місяців", "місяця"), "month"), **dict.fromkeys(("рік", "роки", "років", "року"), "year")},
    "de": {**dict.fromkeys(("Tag", "Tage", "Tagen"), "day"), **dict.fromkeys(("Woche", "Wochen"), "week"), **dict.fromkeys(("Monat", "Monate", "Monaten"), "month"), **dict.fromkeys(("Jahr", "Jahre", "Jahren"), "year")},
    "ru": {**dict.fromkeys(("день", "дня", "дней"), "day"), **dict.fromkeys(("неделя", "неделю", "недели", "недель"), "week"), **dict.fromkeys(("месяц", "месяца", "месяцев"), "month"), **dict.fromkeys(("год", "года", "лет", "году"), "year")},
}
_MODIFIERS = {"en": ("last", "next", "this"), "uk": ("минулого", "наступного", "цього"), "de": ("letzt[ensamr]*", "nächst[ensamr]*", "dies[ensamr]*"), "ru": ("прошл(?:ый|ой|ом)", "следующ(?:ий|ей|ем)", "эт(?:от|ой|ом)")}
_MOD_LOOKUP = {}
_WEEKDAY_LOOKUP = {}
for _lang in _MONTHS:
    _unit = "|".join(sorted(map(re.escape, _UNITS[_lang]), key=len, reverse=True))
    _UNITS[_lang] = {key.casefold(): value for key, value in _UNITS[_lang].items()}
    _PATTERNS[_lang].append(("relative_day", re.compile(r"(?<!\w)(?:" + "|".join(sorted(map(re.escape, _DAY_WORDS[_lang]), key=len, reverse=True)) + r")(?!\w)", re.I)))
    _mods = _MODIFIERS[_lang]
    _MOD_LOOKUP[_lang] = [re.compile(rf"^(?:{mod})$", re.I) for mod in _mods]
    _PATTERNS[_lang].append(("relative_period", re.compile(rf"(?<!\w)(?P<mod>{'|'.join(_mods)})\s+(?P<unit>{_unit})(?!\w)", re.I)))
    _week_names = "|".join(_WEEKDAYS[_lang])
    _WEEKDAY_LOOKUP[_lang] = {word.casefold(): index for index, group in enumerate(_WEEKDAYS[_lang]) for word in group.split("|")}
    _PATTERNS[_lang].append(("weekday", re.compile(rf"(?<!\w)(?:(?P<mod>{'|'.join(_mods)})\s+|(?:{_PREFIX[_lang]})\s+)?(?P<weekday>{_week_names})(?!\w)", re.I)))
    _number = rf"(?P<n>\d+)\s+(?P<unit>{_unit})"
    _ago = {"en": rf"{_number}\s+ago", "uk": rf"{_number}\s+тому", "de": rf"vor\s+{_number}", "ru": rf"{_number}\s+назад"}[_lang]
    _ahead = {"en": rf"in\s+{_number}", "uk": rf"через\s+{_number}", "de": rf"in\s+{_number}", "ru": rf"через\s+{_number}"}[_lang]
    _rolling = {"en": rf"(?:over\s+the\s+last|in\s+the\s+last|the\s+last|last|past)\s+{_number}", "uk": rf"за\s+останні\s+{_number}", "de": rf"(?:in\s+den\s+)?letzten\s+{_number}", "ru": rf"за\s+последние\s+{_number}"}[_lang]
    for _kind, _pattern in (("ago", _ago), ("ahead", _ahead), ("rolling", _rolling)):
        _PATTERNS[_lang].append((_kind, re.compile(rf"(?<!\w){_pattern}(?!\w)", re.I)))
    if _lang in ("uk", "ru"):
        _PATTERNS[_lang].append(("last_year", re.compile(r"\b(?:торік|минулоріч|в прошлом году)\b", re.I)))


def _month_period(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def _period(anchor: date, unit: str) -> tuple[date, date]:
    if unit == "week":
        first = anchor - timedelta(days=anchor.weekday())
        return first, first + timedelta(days=6)
    if unit == "month":
        return _month_period(anchor.year, anchor.month)
    if unit == "year":
        return date(anchor.year, 1, 1), date(anchor.year, 12, 31)
    return anchor, anchor


def _shift(anchor: date, count: int, unit: str) -> date:
    if unit in ("day", "week"):
        return anchor + timedelta(days=count * (7 if unit == "week" else 1))
    index = (anchor.year - 1) * 12 + anchor.month - 1 + count * (12 if unit == "year" else 1)
    year, month = divmod(index, 12)
    year, month = year + 1, month + 1
    return date(year, month, min(anchor.day, calendar.monthrange(year, month)[1]))


def _nearest(ref: date, month: int, day: int | None) -> tuple[date, date]:
    choices = []
    # Eight adjacent years also handle February 29 around a non-leap century.
    for year in range(max(1, ref.year - 8), min(9999, ref.year + 8) + 1):
        try:
            choices.append((date(year, month, day),) * 2 if day is not None else _month_period(year, month))
        except ValueError:
            continue
    return min(choices, key=lambda span: (max((span[0] - ref).days, (ref - span[1]).days, 0), span[0]))


def _resolve(kind: str, match: re.Match, lang: str, ref: date):
    fields = match.groupdict()
    year = int(fields.get("y") or fields.get("ys") or ref.year)
    relative = False
    granularity = "day"
    if kind in ("iso", "numeric"):
        if kind == "iso":
            month, day = int(fields["m"]), int(fields["d"])
        else:
            a, b = int(fields["a"]), int(fields["b"])
            month, day = (a, b) if lang == "en" and a <= 12 else (b, a)
        first = last = date(year, month, day)
    elif kind in ("named", "month"):
        month = _MONTHS[lang][fields["m"].casefold()]
        day = int(fields["d"]) if kind == "named" else None
        granularity = "day" if day is not None else "month"
        if fields.get("y"):
            first, last = (date(year, month, day),) * 2 if day is not None else _month_period(year, month)
        else:
            first, last = _nearest(ref, month, day)
            relative = True
    elif kind in ("year", "last_year", "decade"):
        granularity = "decade" if kind == "decade" else "year"
        if kind == "last_year":
            year, relative = ref.year - 1, True
        first, last = date(year, 1, 1), date(year + (9 if kind == "decade" else 0), 12, 31)
    elif kind in ("quarter", "half"):
        number = int(fields["n"]) if fields.get("n") else next(i for i, pattern in enumerate(_ORDINAL_LOOKUP[lang], 1) if pattern.fullmatch(fields["ord"]))
        width = 6 if kind == "half" else 3
        month = (number - 1) * width + 1
        first, last = date(year, month, 1), _month_period(year, month + width - 1)[1]
        granularity, relative = "quarter", not bool(fields.get("y"))
    elif kind == "relative_day":
        first = last = ref + timedelta(days=_DAY_WORDS[lang][match.group().casefold()])
        relative = True
    elif kind == "weekday":
        weekday = _WEEKDAY_LOOKUP[lang][fields["weekday"].casefold()]
        mod = fields.get("mod")
        future = mod and _MOD_LOOKUP[lang][1].fullmatch(mod)
        delta = (weekday - ref.weekday()) % 7 or 7
        if not future:
            delta = -((ref.weekday() - weekday) % 7 or 7)
        first = last = ref + timedelta(days=delta)
        relative = True
    else:
        unit = _UNITS[lang][fields["unit"].casefold()]
        if kind == "relative_period":
            count = next(offset for offset, pattern in zip((-1, 1, 0), _MOD_LOOKUP[lang]) if pattern.fullmatch(fields["mod"]))
        else:
            count = int(fields["n"])
            if kind == "ago":
                count = -count
        if kind == "rolling":
            if count < 1:
                raise ValueError("Empty rolling period")
            first, last = _shift(ref, -count, unit) + timedelta(days=1), ref
        else:
            first, last = _period(_shift(ref, count, unit), unit)
        granularity, relative = unit, True
    return first, last, granularity, relative


def extract_time_expressions(text: str, lang: str, ref: datetime | date) -> list[TimeExpr]:
    """Extract nonoverlapping periods; invalid inputs and calendar dates are ignored."""
    if not isinstance(text, str) or not isinstance(lang, str) or not isinstance(ref, date):
        return []
    lang = lang.lower().split("-")[0].split("_")[0]
    if lang not in _PATTERNS or not text:
        return []
    ref = ref.date() if isinstance(ref, datetime) else ref
    candidates = []
    invalid_dates = []
    for kind, pattern in _PATTERNS[lang]:
        for match in pattern.finditer(text):
            try:
                first, last, granularity, relative = _resolve(kind, match, lang, ref)
            except (ValueError, OverflowError):
                if kind in ("iso", "numeric", "named"):
                    invalid_dates.append(match.span())
                continue
            direction = "past" if last < ref else "future" if first > ref else "present"
            candidates.append(TimeExpr(match.group(), match.start(), match.end(), first, last, granularity, relative, direction))
    selected = []
    for candidate in sorted(candidates, key=lambda item: (item.start - item.end, item.start)):
        # A malformed full date must not degrade into a valid month/year match.
        if any(candidate.start < end and candidate.end > start for start, end in invalid_dates):
            continue
        if all(candidate.end <= other.start or candidate.start >= other.end for other in selected):
            selected.append(candidate)
    return sorted(selected, key=lambda item: item.start)
