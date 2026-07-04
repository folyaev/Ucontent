import re


RU_STOP_WORDS = {
    "что", "как", "или", "для", "при", "над", "под", "это", "его", "она",
    "они", "уже", "ещё", "еще", "после", "перед", "между", "который",
    "которые", "новости", "лента", "заявил", "заявила", "заявили", "почему",
    "будет", "будут", "свой", "своя", "свое", "свою", "свои", "все",
}
EN_STOP_WORDS = {
    "the", "and", "for", "with", "from", "that", "this", "into", "news",
}
STOP_WORDS = RU_STOP_WORDS | EN_STOP_WORDS

RU_ENDINGS = (
    "иями", "ями", "ами", "ого", "ему", "ыми", "ими", "ией", "иях", "ых",
    "ий", "ый", "ой", "ая", "ое", "ые", "ую", "ом", "ем", "ах", "ях",
    "ов", "ев", "ам", "ям", "ою", "ею", "и", "ы", "а", "я", "о",
    "е", "у", "ю",
)
EN_ENDINGS = ("ing", "ers", "ies", "ed", "es", "s")
TOKEN_ALIASES = {
    "max": {"макс"},
    "макс": {"max"},
}


def normalize_word(word: str) -> str:
    word = word.lower().replace("ё", "е")
    endings = RU_ENDINGS if re.search(r"[а-я]", word) else EN_ENDINGS
    min_len = 5 if endings is RU_ENDINGS else 4
    for ending in endings:
        if len(word) - len(ending) >= min_len and word.endswith(ending):
            return word[: -len(ending)]
    return word


def text_tokens(text: str) -> list[str]:
    words = re.findall(r"[a-zA-Zа-яА-ЯёЁ0-9]+", text.lower().replace("ё", "е"))
    result = []
    for word in words:
        if len(word) < 3 or word in STOP_WORDS:
            continue
        normalized = normalize_word(word)
        if normalized not in STOP_WORDS:
            result.append(normalized)
    return result


def token_set(text: str) -> set[str]:
    tokens = set(text_tokens(text))
    expanded = set(tokens)
    for token in tokens:
        expanded.update(TOKEN_ALIASES.get(token, set()))
    return expanded


def title_signature(title: str, limit: int = 6) -> str:
    tokens = sorted(token_set(title))
    return " ".join(tokens[:limit])


def titles_similar(left: str, right: str, threshold: float = 0.6) -> bool:
    left_tokens = token_set(left)
    right_tokens = token_set(right)
    if not left_tokens or not right_tokens:
        return left.strip().lower() == right.strip().lower()
    overlap = len(left_tokens & right_tokens)
    return overlap / min(len(left_tokens), len(right_tokens)) >= threshold


def matches_query(title: str, query: str) -> bool:
    title_lower = title.lower().replace("ё", "е")
    query_lower = query.lower().replace("ё", "е")
    if query_lower in title_lower:
        return True

    query_tokens = token_set(query)
    if not query_tokens:
        return False
    title_tokens = token_set(title)
    required = max(1, (len(query_tokens) + 1) // 2)
    return len(query_tokens & title_tokens) >= required


def tracked_topic_matches(title: str, topic: str) -> bool:
    topic_tokens = token_set(topic)
    if not topic_tokens:
        return False

    title_tokens = token_set(title)
    if not title_tokens:
        return False

    overlap = len(topic_tokens & title_tokens)
    topic_count = len(topic_tokens)

    if topic_count <= 2:
        return overlap == topic_count
    if topic_count == 3:
        return overlap >= 2

    # For alerts, require a stronger overlap than generic search so a common
    # pair like "app store" does not pull in unrelated items.
    required = max(3, (topic_count * 2 + 2) // 3)
    return overlap >= required
