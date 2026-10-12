"""PulseCast Adaptive: FastAPI app (REST for uploads/config, WebSockets for delivery + dashboard)."""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from . import ai
from .hub import Content, Hub, Media
from .media import compress_image
from .sms import public_configuration, send_announcement
from .tiers import MAX_KBPS, MIN_KBPS, tiers_public

try:  # optional: load backend/.env if python-dotenv happens to be installed
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env", override=False)
except ImportError:
    pass

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_TEXT_CHARS = 5000
RECEIVER_ID = re.compile(r"^[A-Za-z0-9_-]{1,24}$")

app = FastAPI(title="PulseCast Adaptive")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
hub = Hub()
SUPPORTED_LANGUAGES = {"en", "ta"}
MAX_SHARE_BYTES = 64 * 1024
MAX_SHARE_TTL = 24 * 60 * 60


@dataclass
class SecureShare:
    payload: str
    expires_at: float
    one_time: bool


secure_shares: dict[str, SecureShare] = {}


def _clean_expired_shares() -> None:
    now = time.time()
    for token, share in list(secure_shares.items()):
        if share.expires_at <= now:
            secure_shares.pop(token, None)


# ---------------------------------------------------------------- REST ----
@app.get("/api/health")
async def health():
    return {"ok": True, "receivers": len(hub.receivers)}


@app.get("/api/config")
async def config():
    return {
        "tiers": tiers_public(),
        "min_kbps": MIN_KBPS,
        "max_kbps": MAX_KBPS,
        "ai_enabled": ai.ai_enabled(),
        "ai_configured": ai.ai_configured(),
        "ai_model": ai.model_name(),
        "sms": public_configuration(),
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "max_text_chars": MAX_TEXT_CHARS,
    }


@app.get("/api/announcements")
async def announcements(since: int = 0, limit: int = 20, receiver_id: str | None = None):
    """Text-only recovery path: a receiver that reconnects can always get missed announcements."""
    limit = max(0, min(limit, 50))
    if receiver_id is not None and not RECEIVER_ID.match(receiver_id):
        raise HTTPException(422, "receiver_id must be a valid receiver ID.")
    eligible = [
        a for a in hub.announcements
        if a["id"] > since and (a["receiver_ids"] is None or (receiver_id is not None and receiver_id in a["receiver_ids"]))
    ]
    items = eligible[-limit:] if limit else []
    return {"latest_id": hub.latest_id, "items": items}


class SummarizeBody(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)


@app.post("/api/summarize")
async def summarize(body: SummarizeBody):
    return await ai.summarize(body.text)


class TranslateBody(BaseModel):
    text: str = Field(default="", max_length=MAX_TEXT_CHARS)
    primary: str = Field(default="", max_length=MAX_TEXT_CHARS)
    secondary: str = Field(default="", max_length=MAX_TEXT_CHARS)
    tertiary: str = Field(default="", max_length=MAX_TEXT_CHARS)
    secondary_enabled: bool = True
    tertiary_enabled: bool = True
    target_language: str

    @field_validator("target_language")
    @classmethod
    def supported_language(cls, value: str) -> str:
        if value not in SUPPORTED_LANGUAGES:
            raise ValueError("target_language must be 'en' or 'ta'.")
        return value


@app.post("/api/translate")
async def translate(body: TranslateBody):
    try:
        messages = {
            "primary": body.primary or body.text,
            "secondary": body.secondary if body.secondary_enabled else "",
            "tertiary": body.tertiary if body.tertiary_enabled else "",
        }
        if not messages["primary"].strip():
            raise HTTPException(422, "The primary announcement is required.")
        translated = await ai.translate_messages(messages, body.target_language)
        return {
            **translated,
            "secondary_enabled": body.secondary_enabled,
            "tertiary_enabled": body.tertiary_enabled,
        }
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc


class SecureShareBody(BaseModel):
    payload: str = Field(min_length=1, max_length=MAX_SHARE_BYTES * 2)
    expires_in: int = Field(default=900, ge=60, le=MAX_SHARE_TTL)
    one_time: bool = True


@app.post("/api/secure-shares")
async def create_secure_share(body: SecureShareBody):
    """Store only browser-encrypted ciphertext; plaintext and keys never reach this process."""
    _clean_expired_shares()
    token = secrets.token_urlsafe(18)
    secure_shares[token] = SecureShare(
        payload=body.payload,
        expires_at=time.time() + body.expires_in,
        one_time=body.one_time,
    )
    return {"token": token, "expires_at": secure_shares[token].expires_at}


@app.get("/api/secure-shares/{token}")
async def retrieve_secure_share(token: str):
    _clean_expired_shares()
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,64}", token):
        raise HTTPException(400, "Malformed sharing token.")
    share = secure_shares.get(token)
    if share is None:
        raise HTTPException(404, "This sharing link is expired or has already been retrieved.")
    return {"payload": share.payload, "expires_at": share.expires_at}


@app.delete("/api/secure-shares/{token}")
async def consume_secure_share(token: str):
    _clean_expired_shares()
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,64}", token):
        raise HTTPException(400, "Malformed sharing token.")
    share = secure_shares.get(token)
    if share is None:
        raise HTTPException(404, "This sharing link is expired or has already been retrieved.")
    if share.one_time:
        secure_shares.pop(token, None)
    return {"ok": True}


async def _read_upload(file: UploadFile | None, prefix: str, label: str) -> tuple[bytes, str] | None:
    if file is None:
        return None
    mime = (file.content_type or "").lower()
    if not mime.startswith(prefix):
        raise HTTPException(415, f"{label} must be a {prefix.rstrip('/')} file (got '{mime or 'unknown'}').")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"{label} is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    if not data:
        return None
    return data, mime


@app.post("/api/broadcast")
async def broadcast(
    text: str = Form(...),
    summary: str = Form(""),
    language: str = Form("en"),
    secondary: str = Form(""),
    tertiary: str = Form(""),
    secondary_enabled: bool = Form(True),
    tertiary_enabled: bool = Form(True),
    receiver_ids: str = Form(""),
    simulate_media_failure: bool = Form(False),
    image: UploadFile | None = File(None),
    audio: UploadFile | None = File(None),
    video: UploadFile | None = File(None),
    poster: UploadFile | None = File(None),   # a frame the browser extracted from the video
):
    text = text.strip()
    if not text:
        raise HTTPException(422, "Write a text announcement first. It is always delivered, even if media fails.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, f"Announcement is longer than {MAX_TEXT_CHARS} characters.")
    if language not in SUPPORTED_LANGUAGES:
        raise HTTPException(422, "language must be 'en' or 'ta'.")
    secondary = secondary.strip() if secondary_enabled else ""
    tertiary = tertiary.strip() if tertiary_enabled else ""
    for label, value in (("Primary", text), ("Secondary", secondary), ("Tertiary", tertiary)):
        if len(value) > MAX_TEXT_CHARS:
            raise HTTPException(413, f"{label} message is longer than {MAX_TEXT_CHARS} characters.")

    image_up = await _read_upload(image, "image/", "Image")
    audio_up = await _read_upload(audio, "audio/", "Audio")
    video_up = await _read_upload(video, "video/", "Video")
    poster_up = await _read_upload(poster, "image/", "Video frame")

    content = Content(id=hub.next_id(), ts=time.time(), text=text, summary=summary.strip(), language=language,
                      primary=text, secondary=secondary, tertiary=tertiary,
                      simulate_failure=simulate_media_failure)
    if image_up:
        content.image = Media("image", "original", image_up[1], image_up[0])
        small = await asyncio.to_thread(compress_image, image_up[0])
        if small:
            content.image_small = Media("image", "compressed", small[1], small[0])
    if audio_up:
        content.audio = Media("audio", "original", audio_up[1], audio_up[0])
    if video_up:
        content.video = Media("video", "original", video_up[1], video_up[0])
        if poster_up:
            small = await asyncio.to_thread(compress_image, poster_up[0])
            if small:
                content.frame_small = Media("video", "frame", small[1], small[0])

    try:
        requested_receivers = set(json.loads(receiver_ids)) if receiver_ids else None
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(422, "receiver_ids must be a JSON array of receiver IDs.") from exc
    if requested_receivers is not None and (
        not requested_receivers or any(not isinstance(rid, str) or not RECEIVER_ID.match(rid) for rid in requested_receivers)
    ):
        raise HTTPException(422, "Select at least one valid receiver.")
    record = hub.start_broadcast(content, requested_receivers)
    await hub.wait_for_record(record)
    await hub.notify()
    sms = await send_announcement(content.text, content.id)
    return {
        "id": content.id, "receivers": record["receivers"], "compact_text": content.compact,
        "priority_status": record["priority_status"], "delivery": record["delivery"], "sms": sms,
    }


@app.post("/api/reset")
async def reset():
    hub.reset()
    await hub.notify()
    return {"ok": True}


# ----------------------------------------------------------- WebSockets ----
@app.websocket("/ws/dashboard")
async def ws_dashboard(ws: WebSocket):
    await ws.accept()
    hub.dashboards.add(ws)
    try:
        await ws.send_text(json.dumps(hub.snapshot(), separators=(",", ":")))
        while True:
            await ws.receive_text()      # keep-alive; the dashboard only listens
    except WebSocketDisconnect:
        pass
    finally:
        hub.dashboards.discard(ws)


@app.websocket("/ws/receiver/{rid}")
async def ws_receiver(ws: WebSocket, rid: str, kbps: float = 1500):
    if not RECEIVER_ID.match(rid):
        await ws.close(code=4400)
        return
    await ws.accept()
    receiver = await hub.connect_receiver(rid, ws, kbps)
    await hub.replay_pending(receiver)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("type") == "set_bandwidth":
                try:
                    value = float(message["kbps"])
                    if not (value == value) or value in (float("inf"), float("-inf")):
                        raise ValueError("invalid bandwidth")
                    await hub.set_bandwidth(receiver, value)
                except (KeyError, TypeError, ValueError):
                    await ws.send_text(json.dumps({"type": "error", "error": "invalid bandwidth"}))
            elif isinstance(message, dict) and message.get("type") in {"ack", "retry"}:
                try:
                    alert_id = message.get("id")
                    if message["type"] == "ack":
                        await hub.acknowledge(receiver, alert_id)
                    else:
                        await hub.retry_pending(receiver, alert_id)
                except (KeyError, TypeError, ValueError) as exc:
                    await ws.send_text(json.dumps({"type": "error", "error": str(exc)}))
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect_receiver(rid, receiver)
