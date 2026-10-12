"""Run from backend/:  python -m unittest discover -s tests -v
Needs only Pillow (no FastAPI) because the core is framework-free."""
import io
import json
import time
import unittest

from PIL import Image

from app import hub as hubmod
from app.compact import compact_text, extractive_summary, missing_tokens
from app.hub import Content, Hub, Media, build_plan
from app.media import compress_image
from app.tiers import TIERS, tier_for
from app import main as mainmod

hubmod.MAX_REAL_SLEEP = 0  # don't actually wait in tests


class FakeWS:
    def __init__(self):
        self.frames = []

    async def send_text(self, text):
        self.frames.append(text)

    async def close(self):
        pass


def noisy_png(size=(640, 480)) -> bytes:
    import random
    random.seed(1)
    im = Image.frombytes("RGB", size, bytes(random.getrandbits(8) for _ in range(size[0] * size[1] * 3)))
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


LONG = ("Good morning everyone. Due to the storm the ferry to Kavaratti is cancelled today. "
        "The next sailing is tomorrow at 06:30 from Pier 4. Passengers must carry ID. "
        "We apologise for the inconvenience and thank you for your patience as always.")


def make_content(hub, **kw):
    img = noisy_png()
    c = Content(id=hub.next_id(), ts=time.time(), text=LONG, **kw)
    c.image = Media("image", "original", "image/png", img)
    small = compress_image(img)
    c.image_small = Media("image", "compressed", small[1], small[0])
    c.audio = Media("audio", "original", "audio/webm", b"\x01" * 20_000)
    c.video = Media("video", "original", "video/webm", b"\x02" * 80_000)
    frame = compress_image(img, max_side=320, quality=40)
    c.frame_small = Media("video", "frame", frame[1], frame[0])
    return c


class TierRules(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(tier_for(5000).key, "high")
        self.assertEqual(tier_for(1000).key, "high")
        self.assertEqual(tier_for(999).key, "medium")
        self.assertEqual(tier_for(300).key, "medium")
        self.assertEqual(tier_for(299).key, "low")
        self.assertEqual(tier_for(64).key, "low")
        self.assertEqual(tier_for(63).key, "very_low")
        self.assertEqual(tier_for(8).key, "very_low")


class Compact(unittest.TestCase):
    def test_keeps_critical_details(self):
        short = compact_text(LONG)
        self.assertLessEqual(len(short), 160)
        self.assertIn("06:30", short)
        self.assertEqual(missing_tokens(LONG, short), [])

    def test_short_text_untouched(self):
        self.assertEqual(extractive_summary("Meet at 5pm"), "Meet at 5pm")

    def test_missing_tokens_detected(self):
        self.assertEqual(missing_tokens("Bus at 06:30 gate 4", "Bus at gate 4"), ["06:30"])

    def test_image_compression_shrinks(self):
        raw = noisy_png()
        small, mime = compress_image(raw)
        self.assertEqual(mime, "image/jpeg")
        self.assertLess(len(small), len(raw) / 5)
        self.assertIsNone(compress_image(b"not an image"))


class Plans(unittest.TestCase):
    def setUp(self):
        self.hub = Hub()
        self.c = make_content(self.hub)

    def kinds(self, tier_key):
        tier = next(t for t in TIERS if t.key == tier_key)
        out = []
        for f in build_plan(tier, self.c):
            m = json.loads(f.text)
            out.append((m.get("kind"), m.get("variant")) if m.get("type") == "media" else "text")
        return out

    def test_high(self):
        self.assertEqual(self.kinds("high"),
                         ["text", ("audio", "original"), ("image", "original"), ("video", "original")])

    def test_medium(self):
        self.assertEqual(self.kinds("medium"),
                         ["text", ("audio", "original"), ("image", "compressed"), ("video", "frame")])

    def test_low_disables_video_and_images(self):
        self.assertEqual(self.kinds("low"), ["text", ("audio", "original")])

    def test_very_low_is_one_compact_frame(self):
        plan = build_plan(TIERS[-1], self.c)
        self.assertEqual(len(plan), 1)
        msg = json.loads(plan[0].text)
        self.assertEqual(set(msg) - {"x", "language", "priority", "shortened", "w"}, {"t", "i", "m"})
        self.assertEqual(msg["x"], 3)
        self.assertLess(plan[0].size, 300)

    def test_frames_get_smaller_as_tier_drops(self):
        sizes = [sum(f.size for f in build_plan(t, self.c)) for t in TIERS]
        self.assertEqual(sizes, sorted(sizes, reverse=True))


class Delivery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hub = Hub()
        self.sockets = {}
        for rid, kbps in (("fast", 4000), ("mid", 500), ("slow", 100), ("tiny", 20)):
            self.sockets[rid] = FakeWS()
            await self.hub.connect_receiver(rid, self.sockets[rid], kbps)

    async def run_broadcast(self, **kw):
        c = make_content(self.hub, **kw)
        self.hub.start_broadcast(c)
        await self.hub.wait_idle()
        return c

    async def test_bytes_sent_match_frames_actually_sent(self):
        await self.run_broadcast()
        for rid, ws in self.sockets.items():
            wire = sum(len(f.encode("utf-8")) for f in ws.frames)
            self.assertEqual(self.hub.receivers[rid].bytes_sent, wire, rid)
        total = sum(len(f.encode("utf-8")) for ws in self.sockets.values() for f in ws.frames)
        self.assertEqual(self.hub.totals["bytes_sent"], total)

    async def test_each_receiver_gets_its_tier(self):
        await self.run_broadcast()
        types = {rid: [json.loads(f).get("type", "compact") for f in ws.frames]
                 for rid, ws in self.sockets.items()}
        self.assertEqual(types["fast"], ["announcement", "media", "media", "media"])
        self.assertEqual(types["mid"], ["announcement", "media", "media", "media"])
        self.assertEqual(types["slow"], ["announcement", "media"])
        self.assertEqual(types["tiny"], ["compact"])

    async def test_savings_are_measured_against_high_tier(self):
        c = await self.run_broadcast()
        snap = self.hub.snapshot()
        t = snap["totals"]
        self.assertEqual(t["completed_baseline"], hubmod.baseline_bytes(c) * 4)
        self.assertEqual(t["completed_actual"], t["bytes_sent"])
        self.assertGreater(t["saved_pct"], 30)
        fast = next(r for r in snap["receivers"] if r["id"] == "fast")
        self.assertEqual(fast["completed_actual"], fast["completed_baseline"])  # no savings at high tier

    async def test_simulated_failure_keeps_text(self):
        await self.run_broadcast(simulate_failure=True)
        frames = [json.loads(f) for f in self.sockets["fast"].frames]
        self.assertEqual(frames[0]["type"], "announcement")
        self.assertEqual([f["type"] for f in frames[1:]], ["media_failed"] * 3)
        self.assertEqual(self.hub.totals["media_failed"], 3 + 3 + 1 + 0)  # fast, mid, slow(audio only)

    async def test_priorities_are_delivered_in_order_and_gated_by_tier(self):
        c = Content(
            id=self.hub.next_id(), ts=time.time(), text="Primary evacuation instruction",
            secondary="Secondary shelter information", tertiary="Tertiary supporting detail",
        )
        self.hub.start_broadcast(c)
        await self.hub.wait_idle()
        for rid, expected in {
            "fast": ["announcement", "priority", "priority"],
            "mid": ["announcement", "priority"],
            "slow": ["announcement", "priority"],
            "tiny": ["compact"],
        }.items():
            frames = [json.loads(f) for f in self.sockets[rid].frames]
            self.assertEqual([f.get("type", "compact") for f in frames], expected)
        self.assertEqual(self.hub.receivers["fast"].last["priorities"],
                         {"primary": "delivered", "secondary": "delivered", "tertiary": "delivered"})
        self.assertEqual(self.hub.receivers["tiny"].last["priorities"],
                         {"primary": "delivered", "secondary": "withheld", "tertiary": "withheld"})
        self.assertGreater(self.hub.totals["priority_bytes"]["primary"], 0)
        self.assertGreater(self.hub.totals["priority_bytes"]["secondary"], 0)

    async def test_oversized_media_falls_back_to_text(self):
        c = Content(id=self.hub.next_id(), ts=time.time(), text="Short note at 5pm")
        c.audio = Media("audio", "original", "audio/webm", b"\x00" * 120_000)  # ~160 KB framed
        self.hub.start_broadcast(c)
        await self.hub.wait_idle()
        frames = [json.loads(f) for f in self.sockets["slow"].frames]  # 100 kbps -> ~13 s: fine
        self.assertEqual(frames[1]["type"], "media")
        self.hub.receivers["slow"].kbps = 64                            # still low tier...
        c2 = Content(id=self.hub.next_id(), ts=time.time(), text="Another at 6pm")
        c2.audio = Media("audio", "original", "audio/webm", b"\x00" * 150_000)  # ...but ~25 s: too slow
        self.hub.start_broadcast(c2)
        await self.hub.wait_idle()
        last = [json.loads(f) for f in self.sockets["slow"].frames][-2:]
        self.assertEqual(last[0]["type"], "announcement")
        self.assertEqual(last[1]["type"], "media_failed")
        self.assertIn("too large", last[1]["reason"])


    async def test_dead_receiver_does_not_break_others(self):
        class Dead(FakeWS):
            async def send_text(self, text):
                raise RuntimeError("closed")
        await self.hub.connect_receiver("dead", Dead(), 4000)
        await self.run_broadcast()
        self.assertGreater(self.hub.receivers["fast"].bytes_sent, 0)
        self.assertTrue(self.hub.receivers["dead"].last["aborted"])

    async def test_targeted_broadcast_only_reaches_selected_receivers(self):
        content = await self.run_broadcast()
        self.hub.start_broadcast(
            Content(id=self.hub.next_id(), ts=time.time(), text="Targeted notice"),
            {"fast", "mid"},
        )
        await self.hub.wait_idle()
        self.assertEqual(json.loads(self.sockets["fast"].frames[-1])["text"], "Targeted notice")
        self.assertEqual(json.loads(self.sockets["mid"].frames[-1])["text"], "Targeted notice")
        self.assertNotIn("Targeted notice", "\n".join(self.sockets["slow"].frames))
        self.assertNotIn("Targeted notice", "\n".join(self.sockets["tiny"].frames))

    async def test_targeted_broadcast_reports_offline_receiver_without_waiting(self):
        record = self.hub.start_broadcast(
            Content(id=self.hub.next_id(), ts=time.time(), text="Offline notice"),
            {"missing"},
        )
        await self.hub.wait_for_record(record)
        self.assertEqual(record["receivers"], 1)
        self.assertEqual(record["done"], 1)
        self.assertEqual(record["delivery"]["missing"]["status"], "offline")

    async def test_reset_and_stale_disconnect(self):
        await self.run_broadcast()
        self.hub.reset()
        self.assertEqual(self.hub.snapshot()["totals"]["bytes_sent"], 0)
        stale = self.hub.receivers["fast"]
        await self.hub.connect_receiver("fast", FakeWS(), 1000)   # replaces it
        await self.hub.disconnect_receiver("fast", stale)          # stale close must be ignored
        self.assertIn("fast", self.hub.receivers)

    async def test_offline_queue_replay_and_acknowledgement(self):
        content = Content(id=self.hub.next_id(), ts=time.time(), text="Queued alert")
        record = self.hub.start_broadcast(content, {"later"})
        await self.hub.wait_for_record(record)
        self.assertEqual(record["delivery"]["later"]["status"], "offline")
        self.assertEqual(self.hub.snapshot()["pending"]["later"][0]["attempts"], 0)
        ws = FakeWS()
        receiver = await self.hub.connect_receiver("later", ws, 20)
        await self.hub.replay_pending(receiver)
        self.assertEqual(json.loads(ws.frames[-1])["t"], "a")
        self.assertEqual(self.hub.snapshot()["pending"]["later"][0]["status"], "awaiting_ack")
        await self.hub.acknowledge(receiver, content.id)
        self.assertNotIn("later", self.hub.snapshot()["pending"])
        self.assertEqual(record["delivery"]["later"]["status"], "acknowledged")

    async def test_retry_limit_is_validated(self):
        class DeadReplay(FakeWS):
            async def send_text(self, text):
                raise RuntimeError("replay closed")
        content = Content(id=self.hub.next_id(), ts=time.time(), text="Retry alert")
        self.hub.start_broadcast(content, {"retry"})
        receiver = await self.hub.connect_receiver("retry", DeadReplay(), 1000)
        for _ in range(3):
            await self.hub.retry_pending(receiver, content.id)
        self.assertEqual(self.hub.pending["retry"][0]["status"], "exhausted")
        with self.assertRaises(ValueError):
            await self.hub.retry_pending(receiver, content.id)
        with self.assertRaises(ValueError):
            await self.hub.acknowledge(receiver, "bad")

    async def test_snapshot_contains_adaptive_summary_and_reachability(self):
        await self.run_broadcast()
        snap = self.hub.snapshot()
        self.assertIn("adaptive", snap["totals"])
        self.assertIn("adaptive_summary", snap["history"][-1])
        self.assertIn("adaptive_summary", snap["receivers"][0])
        self.assertTrue(snap["reachability"]["fast"]["online"])


class SecureSharing(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        mainmod.secure_shares.clear()

    async def test_encrypted_payload_is_stored_opaque_and_is_one_time(self):
        created = await mainmod.create_secure_share(mainmod.SecureShareBody(
            payload="iv.ciphertext", expires_in=60, one_time=True,
        ))
        token = created["token"]
        self.assertNotIn("password", mainmod.secure_shares[token].payload)
        retrieved = await mainmod.retrieve_secure_share(token)
        self.assertEqual(retrieved["payload"], "iv.ciphertext")
        await mainmod.consume_secure_share(token)
        with self.assertRaises(Exception):
            await mainmod.retrieve_secure_share(token)

    async def test_expired_share_is_removed_without_revealing_payload(self):
        created = await mainmod.create_secure_share(mainmod.SecureShareBody(
            payload="opaque", expires_in=60,
        ))
        token = created["token"]
        mainmod.secure_shares[token].expires_at = 0
        with self.assertRaises(Exception):
            await mainmod.retrieve_secure_share(token)
        self.assertNotIn(token, mainmod.secure_shares)


if __name__ == "__main__":
    unittest.main()
