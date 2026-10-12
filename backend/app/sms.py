"""Backend-only Twilio SMS delivery for announcement notifications."""
from __future__ import annotations

import asyncio
import os
import re
from typing import Any

E164 = re.compile(r"^\+[1-9]\d{7,14}$")
_send_lock = asyncio.Lock()
_sent_by_announcement: dict[int, dict[str, Any]] = {}


def _setting(name: str) -> str:
    return os.getenv(name, "").strip()


def recipient_configuration() -> list[tuple[str, str]]:
    return [
        ("Kabil", _setting("Kabil_number")),
        ("Monesh", _setting("Monesh_number")),
    ]


def public_configuration() -> dict[str, Any]:
    return {
        "configured": _configuration_error() is None and all(number for _, number in recipient_configuration()),
        "recipients": [name for name, _ in recipient_configuration()],
    }


def _configuration_error() -> str | None:
    required = ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER")
    missing = [name for name in required if not _setting(name)]
    if missing:
        return f"Twilio configuration is missing: {', '.join(missing)}."
    if not E164.match(_setting("TWILIO_PHONE_NUMBER")):
        return "TWILIO_PHONE_NUMBER must use international E.164 format."
    return None


async def send_announcement(text: str, announcement_id: int) -> dict[str, Any]:
    """Submit one SMS per configured team member, with in-process idempotency."""
    async with _send_lock:
        if announcement_id in _sent_by_announcement:
            return _sent_by_announcement[announcement_id]

        config_error = _configuration_error()
        recipients = recipient_configuration()
        results: list[dict[str, Any]] = []
        if config_error:
            for name, number in recipients:
                results.append({
                    "recipient": name,
                    "status": "failed",
                    "error": config_error if number else "Recipient number is not configured.",
                })
            result = {"status": "failed", "configured": False, "results": results}
            _sent_by_announcement[announcement_id] = result
            return result

        try:
            from twilio.base.exceptions import TwilioRestException
            from twilio.rest import Client
        except ImportError:
            result = {
                "status": "failed",
                "configured": False,
                "results": [{"recipient": name, "status": "failed", "error": "Twilio SDK is not installed on the backend."} for name, _ in recipients],
            }
            _sent_by_announcement[announcement_id] = result
            return result

        try:
            client = Client(_setting("TWILIO_ACCOUNT_SID"), _setting("TWILIO_AUTH_TOKEN"))
        except Exception:
            result = {
                "status": "failed",
                "configured": True,
                "results": [{"recipient": name, "status": "failed", "error": "Twilio credentials could not be initialized."} for name, _ in recipients],
            }
            _sent_by_announcement[announcement_id] = result
            return result

        for name, number in recipients:
            if not number:
                results.append({"recipient": name, "status": "failed", "error": "Recipient number is not configured."})
                continue
            if not E164.match(number):
                results.append({"recipient": name, "status": "failed", "error": "Recipient number must use international E.164 format."})
                continue
            try:
                message = await asyncio.to_thread(
                    client.messages.create,
                    body=text,
                    from_=_setting("TWILIO_PHONE_NUMBER"),
                    to=number,
                )
                results.append({
                    "recipient": name,
                    "status": "accepted",
                    "message_sid": getattr(message, "sid", None),
                    "provider_status": getattr(message, "status", None),
                })
            except TwilioRestException as exc:
                code = getattr(exc, "code", None)
                results.append({
                    "recipient": name,
                    "status": "failed",
                    "error": f"Twilio rejected the request{f' (code {code})' if code else ''}.",
                })
            except Exception:
                results.append({
                    "recipient": name,
                    "status": "failed",
                    "error": "SMS request failed before Twilio accepted it.",
                })

        status = "accepted" if any(item["status"] == "accepted" for item in results) else "failed"
        result = {"status": status, "configured": True, "results": results}
        _sent_by_announcement[announcement_id] = result
        return result


def reset_for_tests() -> None:
    _sent_by_announcement.clear()
