"""Broadcast hub: receivers, per-tier delivery plans, simulated link, and byte accounting.

Deliberately free of FastAPI imports: a "websocket" is anything with `async send_text(str)`.

Accounting rules (so the dashboard never shows made-up numbers):
  * Bytes sent  = UTF-8 length of every frame actually passed to send_text().
  * Baseline    = bytes a *high-tier* receiver would get for the same broadcast
                  (original media, same JSON/base64 framing). Savings are estimated
                  against that counterfactual, and only for deliveries that finished.
  * Link speed is simulated: each frame waits size*8/capacity seconds (real sleep is
    capped by MAX_REAL_SLEEP so demos stay snappy; the uncapped time is what we report).
"""
from __future__ import annotations

import asyncio
import base64
import json
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .compact import compact_text
from .tiers import TIERS, Tier, clamp_kbps, tier_for

MAX_MEDIA_SECONDS = 20.0   # simulated transfer time above which media falls back to text only
MAX_REAL_SLEEP = 3.0       # wall-clock cap per simulated transfer
MAX_PENDING_RETRIES = 3
RETRY_BACKOFF_SECONDS = (1.0, 2.0, 4.0)


def _dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


@dataclass
class Media:
    kind: str       # "image" | "audio" | "video"
    variant: str    # "original" | "compressed" | "frame"
    mime: str
    data: bytes


@dataclass
class Frame:
    text: str
    size: int
    media_kind: str | None = None   # None for text frames
    priority: str | None = None


@dataclass
class Content:
    id: int
    ts: float
    text: str
    summary: str = ""
    language: str = "en"
    primary: str = ""
    secondary: str = ""
    tertiary: str = ""
    image: Media | None = None
    image_small: Media | None = None
    audio: Media | None = None
    video: Media | None = None
    frame_small: Media | None = None      # compressed video preview frame
    simulate_failure: bool = False
    compact: str = ""
    _media_frames: dict = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self.primary = self.primary.strip() or self.text.strip()
        self.text = self.primary
        self.compact = compact_text(self.primary, self.summary)

    def media_frame(self, media: Media) -> Frame:
        cached = self._media_frames.get(id(media))
        if cached is None:
            payload = _dumps({
                "type": "media", "id": self.id, "kind": media.kind, "variant": media.variant,
                "mime": media.mime, "data": base64.b64encode(media.data).decode("ascii"),
            })
            cached = Frame(payload, len(payload.encode("utf-8")), media.kind, "tertiary")
            self._media_frames[id(media)] = cached
        return cached


def _frame(obj: Any, media_kind: str | None = None, priority: str | None = None) -> Frame:
    text = _dumps(obj)
    return Frame(text, len(text.encode("utf-8")), media_kind, priority)


def build_plan(tier: Tier, c: Content) -> list[Frame]:
    """The rule-based adaptation: which frames does a receiver on this tier get?"""
    if tier.compact_text:
        withheld = sum(1 for m in (c.image, c.video, c.audio) if m)
        withheld_priorities = [p for p, value in (("secondary", c.secondary), ("tertiary", c.tertiary)) if value]
        obj: dict[str, Any] = {
            "t": "a", "i": c.id, "m": c.compact, "language": c.language,
            "priority": "primary", "shortened": c.compact != c.primary, "w": withheld_priorities,
        }
        if withheld:
            obj["x"] = withheld
        return [_frame(obj, priority="primary")]

    attachments: list[dict] = []
    media: list[Media] = []

    def note(kind: str, status: str, variant: str | None = None, reason: str | None = None) -> None:
        item = {"kind": kind, "status": status}
        if variant:
            item["variant"] = variant
        if reason:
            item["reason"] = reason
        attachments.append(item)

    # Audio first: it is the priority medium once video is gone.
    if c.audio:
        if tier.audio:
            media.append(c.audio); note("audio", "sending", "original")
        else:
            note("audio", "skipped", reason="audio is off on this connection")

    if c.image:
        if tier.image == "original":
            media.append(c.image); note("image", "sending", "original")
        elif tier.image == "compressed" and c.image_small:
            media.append(c.image_small); note("image", "sending", "compressed")
        elif tier.image == "compressed":
            note("image", "skipped", reason="the image could not be compressed")
        else:
            note("image", "skipped", reason="images are off on this connection")

    if c.video:
        if tier.video:
            media.append(c.video); note("video", "sending", "original")
        elif tier.image == "compressed" and c.frame_small:
            media.append(c.frame_small); note("video", "substituted", "frame",
                                              "a single frame replaces the video")
        elif tier.image == "compressed":
            note("video", "skipped", reason="no preview frame was available")
        else:
            note("video", "skipped", reason="video is off on this connection")

    withheld_priorities: list[str] = []
    if c.secondary and tier.key == "very_low":
        withheld_priorities.append("secondary")
    if c.tertiary and tier.key != "high":
        withheld_priorities.append("tertiary")

    frames = [_frame({
        "type": "announcement", "id": c.id, "ts": c.ts, "tier": tier.key,
        "text": c.primary, "language": c.language, "priority": "primary",
        "attachments": attachments, "withheld_priorities": withheld_priorities,
    }, priority="primary")]
    if c.secondary and tier.key != "very_low":
        frames.append(_frame({
            "type": "priority", "id": c.id, "priority": "secondary",
            "text": c.secondary, "language": c.language,
        }, priority="secondary"))
    if c.tertiary and tier.key == "high":
        frames.append(_frame({
            "type": "priority", "id": c.id, "priority": "tertiary",
            "text": c.tertiary, "language": c.language,
        }, priority="tertiary"))
    frames.extend(c.media_frame(m) for m in media)
    return frames


def baseline_bytes(c: Content) -> int:
    return sum(f.size for f in build_plan(TIERS[0], c))


@dataclass
class Receiver:
    id: str
    ws: Any
    kbps: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    bytes_sent: int = 0
    messages: int = 0
    media_delivered: int = 0
    media_failed: int = 0
    completed_actual: int = 0
    completed_baseline: int = 0
    priority_bytes: dict[str, int] = field(default_factory=lambda: {"primary": 0, "secondary": 0, "tertiary": 0})
    last: dict | None = None
    adaptive_summary: dict = field(default_factory=dict)

    @property
    def tier(self) -> Tier:
        return tier_for(self.kbps)

    def public(self) -> dict:
        return {
            "id": self.id, "kbps": round(self.kbps), "tier": self.tier.key,
            "bytes_sent": self.bytes_sent, "messages": self.messages,
            "media_delivered": self.media_delivered, "media_failed": self.media_failed,
            "completed_actual": self.completed_actual,
            "completed_baseline": self.completed_baseline, "last": self.last,
            "priority_bytes": self.priority_bytes,
            "adaptive_summary": self.adaptive_summary,
        }


class Hub:
    def __init__(self) -> None:
        self.receivers: dict[str, Receiver] = {}
        self.dashboards: set[Any] = set()
        self.history: deque[dict] = deque(maxlen=40)
        self.announcements: deque[dict] = deque(maxlen=50)
        self._tasks: set[asyncio.Task] = set()
        self._notify_lock = asyncio.Lock()
        self._next_id = 1
        self.pending: dict[str, list[dict]] = {}
        self._reset_totals()

    # ---- state -----------------------------------------------------------
    def _reset_totals(self) -> None:
        self.totals = {
            "bytes_sent": 0, "completed_actual": 0, "completed_baseline": 0,
            "broadcasts": 0, "media_failed": 0, "in_flight": 0,
                "priority_bytes": {"primary": 0, "secondary": 0, "tertiary": 0},
            "adaptive": {"planned_bytes": 0, "actual_bytes": 0, "frames": 0, "media_delivered": 0, "media_failed": 0},
        }

    def next_id(self) -> int:
        value = self._next_id
        self._next_id += 1
        return value

    @property
    def latest_id(self) -> int:
        return self._next_id - 1

    def snapshot(self) -> dict:
        t = self.totals
        saved = max(0, t["completed_baseline"] - t["completed_actual"])
        pct = (saved / t["completed_baseline"] * 100) if t["completed_baseline"] else 0.0
        return {
            "type": "snapshot",
            "receivers": [r.public() for r in self.receivers.values()],
            "totals": {**t, "saved_bytes": saved, "saved_pct": round(pct, 1)},
            "history": list(self.history),
            "reachability": {rid: {"online": rid in self.receivers, "pending": self._pending_public(rid)}
                             for rid in set(self.receivers) | set(self.pending)},
            "pending": {rid: self._pending_public(rid) for rid in self.pending},
        }

    async def notify(self) -> None:
        if not self.dashboards:
            return
        async with self._notify_lock:      # snapshots go out in order; the last one is the newest
            payload = _dumps(self.snapshot())
            for ws in list(self.dashboards):
                try:
                    await ws.send_text(payload)
                except Exception:
                    self.dashboards.discard(ws)

    def reset(self) -> None:
        self._reset_totals()
        self.history.clear()
        self.pending.clear()
        for r in self.receivers.values():
            r.bytes_sent = r.messages = r.media_delivered = r.media_failed = 0
            r.completed_actual = r.completed_baseline = 0
            r.priority_bytes = {"primary": 0, "secondary": 0, "tertiary": 0}
            r.last = None
            r.adaptive_summary = {}

    # ---- receivers -------------------------------------------------------
    async def connect_receiver(self, rid: str, ws: Any, kbps: float) -> Receiver:
        old = self.receivers.get(rid)
        receiver = Receiver(rid, ws, clamp_kbps(kbps))
        self.receivers[rid] = receiver
        if old is not None:
            try:
                await old.ws.close()
            except Exception:
                pass
        await self.notify()
        return receiver

    async def disconnect_receiver(self, rid: str, receiver: Receiver) -> None:
        # Identity check: a stale socket closing must not evict its replacement.
        if self.receivers.get(rid) is receiver:
            del self.receivers[rid]
            await self.notify()

    async def set_bandwidth(self, receiver: Receiver, kbps: float) -> None:
        receiver.kbps = clamp_kbps(kbps)
        await self.notify()

    # ---- broadcasting ----------------------------------------------------
    def start_broadcast(self, c: Content, receiver_ids: set[str] | None = None) -> dict:
        """Register a broadcast and deliver to selected receivers, or everyone when omitted."""
        selected = set(self.receivers) if receiver_ids is None else receiver_ids
        targets = [receiver for rid, receiver in self.receivers.items() if rid in selected]
        delivery = {
            rid: {"status": "sending" if rid in self.receivers else "offline"}
            for rid in selected
        }
        record = {
            "id": c.id, "ts": c.ts, "preview": c.text[:60], "receivers": len(selected),
            "selected_receiver_ids": sorted(selected), "delivery": delivery,
            "done": len(selected) - len(targets), "actual_bytes": 0, "baseline_bytes": 0, "media_failed": 0,
            "by_tier": {t.key: 0 for t in TIERS},
            "priority_bytes": {"primary": 0, "secondary": 0, "tertiary": 0},
            "priority_status": {},
            "adaptive_summary": {"planned_bytes": 0, "actual_bytes": 0, "frames": 0, "media_delivered": 0, "media_failed": 0},
        }
        self.history.append(record)
        self.announcements.append({"id": c.id, "ts": c.ts, "text": c.text, "language": c.language,
                                   "primary": c.primary, "secondary": c.secondary, "tertiary": c.tertiary,
                                   "receiver_ids": None if receiver_ids is None else sorted(selected)})
        self.totals["broadcasts"] += 1
        baseline = baseline_bytes(c)
        for rid in selected - set(self.receivers):
            self._queue_pending(rid, c, record, baseline, "offline")
        for receiver in targets:
            task = asyncio.create_task(self._deliver(receiver, c, record, baseline))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        return record

    def _queue_pending(self, rid: str, c: Content, record: dict, baseline: int, reason: str) -> None:
        queue = self.pending.setdefault(rid, [])
        if any(item["id"] == c.id for item in queue):
            return
        queue.append({"id": c.id, "content": c, "record": record, "baseline": baseline,
                      "attempts": 0, "max_retries": MAX_PENDING_RETRIES, "next_retry_at": 0.0,
                      "last_error": reason, "status": "pending"})
        record["delivery"][rid].update({"label": "Queued for reconnect",
                                         "pending": True,
                                         "retry": {"attempts": 0, "max_retries": MAX_PENDING_RETRIES, "next_retry_at": 0.0, "last_error": reason}})

    def _pending_public(self, rid: str) -> list[dict]:
        return [{k: item[k] for k in ("id", "attempts", "max_retries", "next_retry_at", "last_error", "status")}
                for item in self.pending.get(rid, [])]

    async def replay_pending(self, receiver: Receiver) -> None:
        for item in list(self.pending.get(receiver.id, [])):
            if item["attempts"] >= item["max_retries"]:
                item["status"] = "exhausted"
                continue
            await self._replay_one(receiver, item)
        await self.notify()

    async def _replay_one(self, r: Receiver, item: dict) -> None:
        c, record = item["content"], item["record"]
        item["attempts"] += 1
        item["status"] = "replaying"
        item["next_retry_at"] = time.time() + RETRY_BACKOFF_SECONDS[min(item["attempts"] - 1, len(RETRY_BACKOFF_SECONDS) - 1)]
        try:
            async with r.lock:
                for frame in build_plan(r.tier, c):
                    await r.ws.send_text(frame.text)
                    r.bytes_sent += frame.size
                    self.totals["bytes_sent"] += frame.size
                    record["actual_bytes"] += frame.size
                    record["adaptive_summary"]["actual_bytes"] += frame.size
                    record["adaptive_summary"]["frames"] += 1
                item["status"] = "awaiting_ack"
                record["delivery"][r.id].update({"status": "awaiting_ack", "label": "Replay delivered; acknowledgement required",
                                                  "retry": {k: item[k] for k in ("attempts", "max_retries", "next_retry_at", "last_error")}})
        except Exception as exc:
            item["last_error"] = str(exc)[:200]
            item["status"] = "exhausted" if item["attempts"] >= item["max_retries"] else "pending"
            record["delivery"][r.id]["status"] = item["status"]

    async def acknowledge(self, receiver: Receiver, alert_id: int) -> bool:
        if not isinstance(alert_id, int) or isinstance(alert_id, bool) or alert_id <= 0:
            raise ValueError("ack id must be a positive integer")
        queue = self.pending.get(receiver.id, [])
        match = next((item for item in queue if item["id"] == alert_id), None)
        if match is None:
            raise ValueError("ack id is not pending for this receiver")
        queue.remove(match)
        if not queue:
            self.pending.pop(receiver.id, None)
        match["status"] = "acknowledged"
        match["record"]["delivery"][receiver.id].update({"status": "acknowledged", "label": "Replay acknowledged"})
        await self.notify()
        return True

    async def retry_pending(self, receiver: Receiver, alert_id: int) -> bool:
        if not isinstance(alert_id, int) or isinstance(alert_id, bool) or alert_id <= 0:
            raise ValueError("retry id must be a positive integer")
        item = next((x for x in self.pending.get(receiver.id, []) if x["id"] == alert_id), None)
        if item is None:
            raise ValueError("retry id is not pending for this receiver")
        if item["attempts"] >= item["max_retries"]:
            raise ValueError("retry limit reached")
        await self._replay_one(receiver, item)
        await self.notify()
        return True

    async def wait_idle(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def wait_for_record(self, record: dict) -> None:
        while record["done"] < record["receivers"]:
            await asyncio.sleep(0)

    async def _deliver(self, r: Receiver, c: Content, record: dict, baseline: int) -> None:
        self.totals["in_flight"] += 1
        sent = 0
        sim_ms = 0.0
        failures = 0
        aborted = False
        try:
            async with r.lock:                       # one transfer at a time per link
                tier = r.tier
                record["by_tier"][tier.key] += 1
                frames = build_plan(tier, c)
                receiver_summary = {"tier": tier.key, "planned_bytes": sum(f.size for f in frames),
                                    "actual_bytes": 0, "frames": 0,
                                    "media_delivered": 0, "media_failed": 0}
                for frame in frames:
                    failed = False
                    if frame.media_kind:
                        reason = None
                        if c.simulate_failure:
                            reason = "simulated delivery failure"
                        elif frame.size * 8 / (r.kbps * 1000) > MAX_MEDIA_SECONDS:
                            reason = (f"too large for this connection "
                                      f"(~{frame.size * 8 / (r.kbps * 1000):.0f}s at {round(r.kbps)} kbps)")
                        if reason:
                            frame = _frame({"type": "media_failed", "id": c.id,
                                            "kind": frame.media_kind, "reason": reason})
                            failures += 1
                            failed = True
                    seconds = frame.size * 8 / (r.kbps * 1000)
                    await asyncio.sleep(min(seconds, MAX_REAL_SLEEP))
                    try:
                        await r.ws.send_text(frame.text)
                    except Exception:
                        aborted = True               # receiver went away mid-delivery
                        break
                    sent += frame.size
                    sim_ms += seconds * 1000
                    record["adaptive_summary"]["actual_bytes"] += frame.size
                    record["adaptive_summary"]["frames"] += 1
                    record["adaptive_summary"]["planned_bytes"] = baseline
                    receiver_summary["actual_bytes"] += frame.size
                    receiver_summary["frames"] += 1
                    r.bytes_sent += frame.size
                    self.totals["bytes_sent"] += frame.size
                    priority = frame.priority or "primary"
                    r.priority_bytes[priority] += frame.size
                    record["priority_bytes"][priority] += frame.size
                    self.totals["priority_bytes"][priority] += frame.size
                    record["priority_status"].setdefault(priority, "delivered")
                    if frame.media_kind and not failed:
                        r.media_delivered += 1
                        record["adaptive_summary"]["media_delivered"] += 1
                        receiver_summary["media_delivered"] += 1
                    if failed:
                        record["adaptive_summary"]["media_failed"] += 1
                        receiver_summary["media_failed"] += 1
                    await self.notify()
        finally:
            self.totals["in_flight"] -= 1
            r.messages += 1
            r.media_failed += failures
            self.totals["media_failed"] += failures
            record["media_failed"] += failures
            record["done"] += 1
            if not aborted:                          # only compare deliveries that completed
                r.completed_actual += sent
                r.completed_baseline += baseline
                self.totals["completed_actual"] += sent
                self.totals["completed_baseline"] += baseline
                record["actual_bytes"] += sent
                record["baseline_bytes"] += baseline
            r.last = {"id": c.id, "tier": r.tier.key, "bytes": sent,
                      "sim_ms": round(sim_ms), "media_failed": failures, "aborted": aborted}
            delivered = set()
            for frame in build_plan(r.tier, c):
                if frame.priority:
                    delivered.add(frame.priority)
            r.last["priorities"] = {
                p: ("delivered" if p in delivered else "withheld")
                for p, value in (("primary", c.primary), ("secondary", c.secondary), ("tertiary", c.tertiary))
                if value
            }
            record["delivery"][r.id] = {
                "status": "failed" if aborted else "sent",
                "label": "Delivery interrupted" if aborted else "Sent to connected receiver",
                "tier": r.tier.key, "adaptive_summary": {**receiver_summary, "actual_bytes": sent},
            }
            if aborted:
                self._queue_pending(r.id, c, record, baseline, "socket delivery interrupted")
            r.adaptive_summary = {**receiver_summary, "actual_bytes": sent,
                                  "pending": len(self.pending.get(r.id, []))}
            self.totals["adaptive"]["planned_bytes"] += baseline
            self.totals["adaptive"]["actual_bytes"] += sent
            self.totals["adaptive"]["frames"] += receiver_summary["frames"]
            self.totals["adaptive"]["media_delivered"] += receiver_summary["media_delivered"]
            self.totals["adaptive"]["media_failed"] += receiver_summary["media_failed"]
            await self.notify()
