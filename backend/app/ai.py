"""Optional AI summarisation (Groq). Falls back to a rule-based summary when unavailable."""
from __future__ import annotations

import os

from .compact import COMPACT_LIMIT, extractive_summary, missing_tokens, normalize

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

SYSTEM_PROMPT = (
    "You compress announcements into short alerts for people on very slow networks. "
    f"Rules: at most {COMPACT_LIMIT} characters; keep every number, date, time, place, name "
    "and required action; drop greetings and filler; plain text only; "
    "reply with the alert and nothing else."
)


def ai_enabled() -> bool:
    return ai_configured()


def ai_configured() -> bool:
    return bool(os.getenv("GROQ_API_KEY", "").strip())


def model_name() -> str:
    return os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")


async def summarize(text: str) -> dict:
    key = os.getenv("GROQ_API_KEY", "").strip()
    model = model_name()
    summary = ""
    source = "offline"
    warning = None

    if key:
        try:
            import httpx

            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post(
                    GROQ_URL,
                    headers={"Authorization": "Bearer " + key},
                    json={
                        "model": model,
                        "temperature": 0.2,
                        "max_tokens": 120,
                        "messages": [
                            {"role": "system", "content": SYSTEM_PROMPT},
                            {"role": "user", "content": text},
                        ],
                    },
                )
                response.raise_for_status()
                summary = normalize(response.json()["choices"][0]["message"]["content"]).strip('"')
                source = "groq"
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            detail = "authentication failed" if status in (401, 403) else f"provider returned HTTP {status}"
            warning = f"Groq summary {detail}. Used the offline summary instead."
            summary = ""
        except (KeyError, TypeError, ValueError):
            warning = "Groq returned an invalid summary response. Used the offline summary instead."
            summary = ""
        except Exception as exc:  # network, timeout, or unavailable provider
            warning = f"Groq summary request failed ({type(exc).__name__}). Used the offline summary instead."
            summary = ""
    else:
        warning = "No GROQ_API_KEY set. Used the offline summary instead."

    if not summary and source == "groq" and not warning:
        warning = "Groq returned an empty summary. Used the offline summary instead."
    if not summary:
        summary = extractive_summary(text)
        source = "offline"
    elif len(summary) > COMPACT_LIMIT:
        summary = extractive_summary(summary)

    missing = missing_tokens(text, summary)
    if missing and not warning:
        warning = "Check the summary: these details from the original are missing: " + ", ".join(missing)

    return {"summary": summary, "source": source, "warning": warning, "missing": missing}


async def translate(text: str, target_language: str) -> dict:
    """Translate an announcement without losing operational details.

    Translation intentionally has no offline translation fallback: a guessed
    translation could change an emergency instruction. The composer can still
    use the local templates or edit manually when Groq is unavailable.
    """
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        raise RuntimeError("No GROQ_API_KEY is configured. Choose a template or enter the translation manually.")

    language_name = {"en": "English", "ta": "Tamil"}[target_language]
    prompt = (
        f"Translate the announcement below into {language_name}. Preserve every location, "
        "date, time, number, destination, named entity, and required action exactly. "
        "Do not add, remove, or change emergency instructions. Return only the translation.\n\n"
        f"{text}"
    )
    try:
        import httpx

        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                GROQ_URL,
                headers={"Authorization": "Bearer " + key},
                json={
                    "model": os.getenv("GROQ_MODEL", "llama-3.1-8b-instant"),
                    "temperature": 0.0,
                    "max_tokens": 600,
                    "messages": [
                        {"role": "system", "content": "You are a careful emergency communications translator."},
                        {"role": "user", "content": prompt},
                    ],
                },
            )
            response.raise_for_status()
            translated = normalize(response.json()["choices"][0]["message"]["content"]).strip('"')
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        detail = "authentication failed" if status in (401, 403) else f"provider returned HTTP {status}"
        raise RuntimeError(f"Groq translation {detail}. Use a template or enter it manually.") from exc
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError("Groq returned an invalid translation response. Use a template or enter it manually.") from exc
    except Exception as exc:
        raise RuntimeError(f"Groq translation request failed ({type(exc).__name__}). Use a template or enter it manually.") from exc

    if not translated:
        raise RuntimeError("Groq returned an empty translation. Use a template or enter it manually.")
    missing = missing_tokens(text, translated)
    warning = None
    if missing:
        warning = "Review the translation: these numeric details may be missing: " + ", ".join(missing)
    return {"text": translated, "language": target_language, "warning": warning, "missing": missing}


async def translate_messages(messages: dict[str, str], target_language: str) -> dict:
    translated: dict[str, str] = {}
    warnings: dict[str, str | None] = {}
    missing: dict[str, list[str]] = {}
    for priority, text in messages.items():
        if not text.strip():
            translated[priority] = ""
            continue
        result = await translate(text, target_language)
        translated[priority] = result["text"]
        warnings[priority] = result["warning"]
        missing[priority] = result["missing"]
    return {"messages": translated, "language": target_language, "warnings": warnings, "missing": missing}
