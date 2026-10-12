"""Bandwidth tiers and the (deliberately simple) rule that maps capacity -> tier.

This module is the single source of truth. The frontend fetches it from /api/config.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

MIN_KBPS = 8
MAX_KBPS = 5000


@dataclass(frozen=True)
class Tier:
    key: str
    label: str
    min_kbps: int          # tier applies when capacity >= min_kbps
    video: bool            # send the original video
    image: str             # "original" | "compressed" | "none"
    audio: bool
    compact_text: bool     # True -> only a compact text frame is sent
    description: str


# Ordered best -> worst. The first tier whose min_kbps <= capacity wins.
TIERS: tuple[Tier, ...] = (
    Tier("high", "High", 1000, True, "original", True, False,
         "Video, audio, images and text"),
    Tier("medium", "Medium", 300, False, "compressed", True, False,
         "Compressed images or a video frame, audio and text"),
    Tier("low", "Low", 64, False, "none", True, False,
         "Audio and text, no video or images"),
    Tier("very_low", "Very low", 0, False, "none", False, True,
         "Compact text only"),
)


def clamp_kbps(value: float) -> float:
    return max(MIN_KBPS, min(MAX_KBPS, float(value)))


def tier_for(kbps: float) -> Tier:
    for tier in TIERS:
        if kbps >= tier.min_kbps:
            return tier
    return TIERS[-1]


def tiers_public() -> list[dict]:
    return [asdict(t) for t in TIERS]
