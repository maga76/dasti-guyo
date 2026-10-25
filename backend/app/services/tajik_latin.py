"""Таджикская кириллица → узбекская латиница — чтобы узбекский женский голос Madina
(Microsoft, нейросетевой) читал таджикские слова почти как носитель.

Звуки двух языков очень близки: о [ɒ], қ → q, ғ → gʻ, ҳ → h, х → x, ҷ → j, ӯ → oʻ.
Общие слова (Salom, Tashakkur, Rahmat) пишутся одинаково.
"""

LETTERS = {
    "а": "a", "б": "b", "в": "v", "г": "g", "ғ": "gʻ", "д": "d", "е": "e", "ё": "yo", "ж": "j",
    "з": "z", "и": "i", "ӣ": "i", "й": "y", "к": "k", "қ": "q", "л": "l", "м": "m", "н": "n",
    "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ӯ": "oʻ", "ф": "f", "х": "x",
    "ҳ": "h", "ч": "ch", "ҷ": "j", "ш": "sh", "ъ": "ʼ", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}
VOWELS = set("аеёиӣоуӯэюя")


def to_latin(text: str) -> str:
    out = []
    prev = ""
    for ch in text:
        low = ch.lower()
        if low in LETTERS:
            lat = LETTERS[low]
            # «е» в начале слова и после гласной звучит как «йе»
            if low == "е" and (not prev or not prev.isalpha() or prev.lower() in VOWELS):
                lat = "ye"
            if ch.isupper() and lat:
                lat = lat[0].upper() + lat[1:]
            out.append(lat)
        else:
            out.append(ch)
        prev = ch
    return "".join(out)
