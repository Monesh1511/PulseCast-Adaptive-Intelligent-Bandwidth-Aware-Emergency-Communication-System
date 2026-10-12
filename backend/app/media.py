"""Image compression for the medium tier (Pillow only, no video encoding)."""
from __future__ import annotations

import io

from PIL import Image, ImageOps


def compress_image(data: bytes, max_side: int = 480, quality: int = 45) -> tuple[bytes, str] | None:
    """Downscale + re-encode as JPEG. Returns None if the bytes are not a readable image."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((max_side, max_side))
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                background = Image.new("RGB", im.size, (255, 255, 255))
                background.paste(im, mask=im.split()[-1])
                im = background
            else:
                im = im.convert("RGB")
            out = io.BytesIO()
            im.save(out, "JPEG", quality=quality, optimize=True)
            return out.getvalue(), "image/jpeg"
    except Exception:
        return None
