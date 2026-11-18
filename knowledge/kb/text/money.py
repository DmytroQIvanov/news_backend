"""Small, dependency-free monetary and physical quantity extractors.

An unqualified yen sign means JPY; explicit yuan names and CNY mean CNY.
Gas volumes are normalized to billion cubic metres (bcm); rates retain their
source text and use the base unit, e.g. ``barrels`` for barrels per day.
"""

import math
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class MoneyExpr:
    text: str
    start: int
    end: int
    amount: float
    currency: str
    approximate: bool
    qualifier: str | None


@dataclass(frozen=True)
class QuantityExpr:
    text: str
    start: int
    end: int
    value: float
    unit: str
    approximate: bool


_SPACE = " \u00a0\u202f"
_NUMBER = rf"[+-]?(?:\d{{1,3}}(?:[{_SPACE}]\d{{3}})+|\d+)(?:[.,]\d+)*"
_NUMBER_FULL = re.compile(rf"^{_NUMBER}$")
_SPLIT = re.compile(r"[.,]")
_SPACE_RE = re.compile(rf"[{_SPACE}]")
_SCALES = {
    1e3: "k|thousand|thousands|тис|тис.|тисяча|тисячі|тисяч|тисячу|тисячею|тисячами|тыс|тыс.|тысяча|тысячи|тысяч|Tsd|Tsd.|Tausend",
    1e6: "m|mn|million|millions|млн|млн.|мільйон|мільйона|мільйони|мільйонів|мільйону|мільйоном|мільйонами|миллион|миллиона|миллионов|Mio|Mio.|Millionen",
    1e9: "b|bn|billion|billions|млрд|млрд.|мільярд|мільярда|мільярди|мільярдів|мільярду|мільярдом|мільярдами|миллиард|миллиарда|миллиардов|Mrd|Mrd.|Milliarde|Milliarden",
    1e12: "t|tn|trln|trillion|trillions|трлн|трлн.|трильйон|трильйона|трильйони|трильйонів|трильйону|трильйоном|трильйонами|триллион|триллиона|триллионов|Billionen",
}
_SCALE_VALUES = {word.casefold(): scale for scale, words in _SCALES.items() for word in words.split("|")}
_CURRENCIES = {
    "USD": "USD|US$|$|долар|долара|долари|доларів|долару|доларами|дол.|дол|доллар|доллара|долларов|dollar|dollars|US dollar|US dollars|доларів США|долари США|долар США|долларов США",
    "EUR": "EUR|€|євро|евро|euro|euros",
    "UAH": "UAH|₴|грн|грн.|гривня|гривні|гривень|гривню|гривнею|гривнями|hryvnia|hryvnias",
    "GBP": "GBP|£|pound|pounds|pound sterling|pounds sterling|фунт|фунти|фунтів|фунтів стерлінгів|Pfund",
    "JPY": "JPY|JP¥|¥|yen|єна|єн|єни|ієн|иен",
    "CNY": "CNY|RMB|CN¥|yuan|renminbi|юань|юані|юанів|юаней",
    "RUB": "RUB|₽|руб|руб.|рубль|рублі|рублів|рубля|рублей|ruble|rubles|rouble|roubles",
    "PLN": "PLN|zł|zloty|zlotys|złoty|złotych|злотий|злотих",
    "CHF": "CHF|Swiss franc|Swiss francs|Schweizer Franken|швейцарських франків",
    "CAD": "CAD|CA$|C$|Canadian dollars|канадських доларів",
    "AUD": "AUD|AU$|A$|Australian dollars|австралійських доларів",
}
_CURRENCY_VALUES = {word.casefold(): currency for currency, words in _CURRENCIES.items() for word in words.split("|")}
_QUALIFIERS = {
    "over": "over|more than|above|понад|більше ніж|більш як|свыше|более|über|mehr als|>",
    "under": "under|less than|below|nearly|almost|менше ніж|менш як|майже|менее|почти|unter|weniger als|knapp|<",
    "about": "about|around|approximately|roughly|близько|приблизно|орієнтовно|около|примерно|etwa|rund|ungefähr|~|≈",
    "up_to": "up to|до|не більше ніж|bis zu|höchstens",
}
_QUALIFIER_VALUES = {word.casefold(): qualifier for qualifier, words in _QUALIFIERS.items() for word in words.split("|")}


def _alternation(words) -> str:
    # Word-ending tokens require a boundary, symbols and dotted abbreviations do not.
    return "(?:" + "|".join(re.escape(word) + (r"(?!\w)" if word[-1].isalnum() else "") for word in sorted(words, key=len, reverse=True)) + ")"


_SCALE = _alternation(_SCALE_VALUES)
_CURRENCY = _alternation(_CURRENCY_VALUES)
_QUALIFIER = _alternation(_QUALIFIER_VALUES)
_LEAD = rf"(?<![\w.,+\-])(?:(?P<qualifier>{_QUALIFIER})\s*)?"
_AMOUNT = rf"(?P<number>{_NUMBER})(?![\d.,]\d)(?:\s*(?P<scale>{_SCALE}))?"
_MONEY_PATTERNS = (
    re.compile(rf"{_LEAD}(?P<currency>{_CURRENCY})\s*{_AMOUNT}(?:\s*{_CURRENCY})?(?!\w)", re.I),
    re.compile(rf"{_LEAD}{_AMOUNT}\s*(?P<currency>{_CURRENCY})(?!\w)", re.I),
)
_UNIT_WORDS = {
    "percent": "percent|percentage points|per cent|Prozent|Prozentpunkte|Prozentpunkten|відсоток|відсотка|відсотки|відсотків|відсоткових пунктів|процент|процентов|%",
    "people": "people|persons|person|людина|людини|людей|осіб|особа|особи|человек|людей|Menschen|Personen",
    "tonnes": "tonnes|tonne|tons|ton|тонн|тонни|тонна|тонну|тоннами|Tonnen|Tonne",
    "barrels": "barrels per day|barrels a day|barrel per day|barrels|barrel|барелів на добу|барелів|барелі|барель|баррелей в сутки|баррелей|Barrel pro Tag|Barrel",
    "bcm": "bcm|billion cubic metres|billion cubic meters",
    "cubic_metres": "кубометрів|кубометри|кубометр|кубічних метрів|кубометров|cubic metres|cubic meters|Kubikmeter|м³|m³",
    "mw": "MW|МВт|megawatts|megawatt|мегават|мегаватів|Megawatt",
    "gw": "GW|ГВт|gigawatts|gigawatt|гігаватів|Gigawatt",
    "km": "km|км|kilometres|kilometers|кілометрів|кілометри|Kilometer",
    "units": "units|unit|одиниць|одиниці|штук|штуки|Stück",
}
_UNIT_VALUES = {word.casefold(): unit for unit, words in _UNIT_WORDS.items() for word in words.split("|")}
_QUANTITY_PATTERN = re.compile(rf"{_LEAD}{_AMOUNT}\s*(?P<unit>{_alternation(_UNIT_VALUES)})(?!\w)", re.I)


def _language(lang: str) -> str:
    return lang.lower().split("-")[0].split("_")[0] if isinstance(lang, str) else ""


def parse_number(token: str, lang: str) -> float | None:
    """Parse decimal/group separators without accepting malformed numeric tokens.

    A single dot is decimal except for a three-digit German grouping. A comma
    is decimal outside English; in English three-digit groups are thousands.
    Mixed punctuation uses the final separator as the decimal separator.
    """
    if not isinstance(token, str) or not isinstance(lang, str):
        return None
    token = token.strip()
    if not token or not _NUMBER_FULL.fullmatch(token):
        return None
    compact = _SPACE_RE.sub("", token)
    sign = "-" if compact.startswith("-") else ""
    compact = compact.lstrip("+-")
    lang = _language(lang)
    if "." in compact and "," in compact:
        decimal = "." if compact.rfind(".") > compact.rfind(",") else ","
        group = "," if decimal == "." else "."
        integer, fractional = compact.rsplit(decimal, 1)
        parts = integer.split(group)
        if decimal in integer or not (1 <= len(parts[0]) <= 3) or any(len(part) != 3 for part in parts[1:]):
            return None
        compact = "".join(parts) + "." + fractional
    elif "." in compact or "," in compact:
        separator = "." if "." in compact else ","
        parts = _SPLIT.split(compact)
        grouped = 1 <= len(parts[0]) <= 3 and all(len(part) == 3 for part in parts[1:])
        if len(parts) > 2:
            if not grouped:
                return None
            compact = "".join(parts)
        elif grouped and ((separator == "," and lang == "en") or (separator == "." and lang == "de")):
            compact = "".join(parts)
        else:
            compact = ".".join(parts)
    try:
        value = float(sign + compact)
    except (ValueError, OverflowError):
        return None
    return value if math.isfinite(value) else None


def _expanded(match: re.Match, lang: str) -> float | None:
    number = parse_number(match["number"], lang)
    if number is None:
        return None
    scale = (match["scale"] or "").casefold()
    multiplier = 1e12 if _language(lang) == "de" and scale in ("billion", "billionen") else _SCALE_VALUES.get(scale, 1.0)
    value = number * multiplier
    return value if math.isfinite(value) else None


def _nonoverlapping(candidates):
    selected = []
    for candidate in sorted(candidates, key=lambda item: (item.start - item.end, item.start)):
        if all(candidate.end <= other.start or candidate.start >= other.end for other in selected):
            selected.append(candidate)
    return sorted(selected, key=lambda item: item.start)


def extract_money(text: str, lang: str) -> list[MoneyExpr]:
    """Return expanded amounts with an explicit currency, ordered by offset."""
    if not isinstance(text, str) or not isinstance(lang, str) or not text:
        return []
    candidates = []
    for pattern in _MONEY_PATTERNS:
        for match in pattern.finditer(text):
            amount = _expanded(match, lang)
            if amount is None:
                continue
            qualifier = _QUALIFIER_VALUES.get((match["qualifier"] or "").casefold())
            candidates.append(MoneyExpr(match.group(), match.start(), match.end(), amount, _CURRENCY_VALUES[match["currency"].casefold()], qualifier is not None, qualifier))
    return _nonoverlapping(candidates)


def extract_quantities(text: str, lang: str) -> list[QuantityExpr]:
    """Return quantities with explicit physical/count units, including scales."""
    if not isinstance(text, str) or not isinstance(lang, str) or not text:
        return []
    candidates = []
    for match in _QUANTITY_PATTERN.finditer(text):
        value = _expanded(match, lang)
        if value is None:
            continue
        unit = _UNIT_VALUES[match["unit"].casefold()]
        if unit == "cubic_metres":
            value, unit = value / 1e9, "bcm"
        candidates.append(QuantityExpr(match.group(), match.start(), match.end(), value, unit, match["qualifier"] is not None))
    return _nonoverlapping(candidates)
