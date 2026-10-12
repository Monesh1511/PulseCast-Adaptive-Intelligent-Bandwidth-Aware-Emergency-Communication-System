"""Text compaction used for the very-low tier, plus a check that critical details survive."""
from __future__ import annotations

import re

COMPACT_LIMIT = 160

_SENTENCES = re.compile(r"(?<=[.!?])\s+|\n+")
_KEYWORDS = re.compile(
    r"\b(urgent|immediately|now|today|tonight|tomorrow|evacuat\w*|cancel\w*|postpone\w*|"
    r"delay\w*|deadline|warning|alert|danger\w*|closed|closure|moved|relocat\w*|must|"
    r"required|avoid|emergency|meeting|until)\b",
    re.I,
)
_NUMBERS = re.compile(r"\d[\d:.,/\-]*\d|\d")


def normalize(text: str) -> str:
    return " ".join(text.split())


def truncate(text: str, limit: int) -> str:
    text = normalize(text)
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    if " " in cut[limit // 2:]:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-") + "…"


def extractive_summary(text: str, limit: int = COMPACT_LIMIT) -> str:
    """Rule-based fallback: keep the sentences most likely to carry critical info."""
    flat = normalize(text)
    if len(flat) <= limit:
        return flat

    sentences = [normalize(s) for s in _SENTENCES.split(text) if s and s.strip()]
    scored = []
    for i, sentence in enumerate(sentences):
        score = 3.0 if i == 0 else 0.0
        if re.search(r"\d", sentence):
            score += 2
        score += min(len(_KEYWORDS.findall(sentence)), 3)
        score -= len(sentence) / 200
        scored.append((score, i, sentence))

    chosen: list[tuple[int, str]] = []
    used = 0
    for _, i, sentence in sorted(scored, key=lambda t: -t[0]):
        extra = len(sentence) + (1 if chosen else 0)
        if used + extra <= limit:
            chosen.append((i, sentence))
            used += extra

    if not chosen:
        return truncate(sentences[0] if sentences else flat, limit)
    return " ".join(s for _, s in sorted(chosen))


def compact_text(text: str, summary: str = "", limit: int = COMPACT_LIMIT) -> str:
    """Text that goes out on the very-low tier: the AI/user summary if present, else extractive."""
    return extractive_summary(summary.strip() or text, limit)


def critical_tokens(text: str) -> list[str]:
    """Numbers, times and dates in the text (deduplicated, in order)."""
    seen: list[str] = []
    for match in _NUMBERS.findall(text):
        token = match.strip(".,:-/")
        if token and token not in seen:
            seen.append(token)
    return seen


def missing_tokens(original: str, summary: str) -> list[str]:
    flat = normalize(summary)
    return [t for t in critical_tokens(original) if t not in flat]
