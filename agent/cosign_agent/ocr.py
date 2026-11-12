"""Local OCR for scanned PDFs and photos of invoices. No vision model and no API: RapidOCR runs
PaddleOCR's models on ONNX Runtime inside this process, so a photographed bill becomes text that
then goes through exactly the same injection scan and reader as a pasted one.

OCR only transcribes. It never decides, and its output is treated like any other untrusted text."""

from __future__ import annotations

import io
import logging
import threading

from .llm import Unreadable

MAX_PAGES = 5
RENDER_SCALE = 2.0  # about 144 dpi: sharp enough for small print, fast enough for a demo

_engine = None
_lock = threading.Lock()


def available() -> bool:
    try:
        import rapidocr  # noqa: F401
        import onnxruntime  # noqa: F401
    except ImportError:
        return False
    return True


def _get_engine():
    global _engine
    with _lock:
        if _engine is None:
            if not available():
                raise Unreadable("this document is an image or a scan, and OCR is not installed (pip install rapidocr onnxruntime)")
            from rapidocr import RapidOCR

            for name in ("RapidOCR", "rapidocr"):
                logging.getLogger(name).setLevel(logging.WARNING)
            _engine = RapidOCR()
        return _engine


def _lines(result) -> list[str]:
    """Groups OCR boxes into reading-order lines: boxes whose vertical centres are close sit on
    one line (so "Total due:" and "USD 850.00" in two columns stay together), left to right."""
    boxes, txts = getattr(result, "boxes", None), getattr(result, "txts", None)
    if boxes is None or not txts:
        return []
    items = []
    for box, txt in zip(boxes, txts):
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        items.append(((min(ys) + max(ys)) / 2, max(ys) - min(ys), min(xs), str(txt)))
    items.sort(key=lambda i: (i[0], i[2]))
    lines: list[list[tuple]] = []
    for it in items:
        if lines:
            last = lines[-1]
            centre = sum(x[0] for x in last) / len(last)
            height = max(x[1] for x in last)
            if abs(it[0] - centre) < max(height, it[1]) * 0.5:
                last.append(it)
                continue
        lines.append([it])
    return ["  ".join(x[3] for x in sorted(line, key=lambda x: x[2])) for line in lines]


MAX_SIDE = 2400  # phone photos are often 4000+ px; this keeps small print legible and OCR fast


def _prepare(data: bytes) -> bytes:
    """Phone photos: apply the EXIF rotation (otherwise a portrait shot is read sideways) and
    shrink very large images. Returns PNG bytes. Bytes Pillow cannot open are passed through."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return data
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        if max(img.size) > MAX_SIDE:
            img.thumbnail((MAX_SIDE, MAX_SIDE))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        raise Unreadable(f"this file is not an image Cosign can open (PNG, JPEG or WebP): {e}") from e


def image_to_text(data: bytes) -> str:
    engine = _get_engine()
    try:
        result = engine(_prepare(data))
    except Unreadable:
        raise
    except Exception as e:
        raise Unreadable(f"OCR could not read the image: {e}") from e
    text = "\n".join(_lines(result))
    if not text.strip():
        raise Unreadable("no text was found in the image. Photograph the invoice flat, in good light, with the whole page in frame")
    return text


def pdf_pages_to_png(data: bytes, max_pages: int = MAX_PAGES) -> list[bytes]:
    try:
        import pypdfium2 as pdfium
    except ImportError as e:
        raise Unreadable("this PDF is a scan, and pypdfium2 is not installed to render it") from e
    pages: list[bytes] = []
    pdf = pdfium.PdfDocument(data)
    try:
        for i in range(min(len(pdf), max_pages)):
            img = pdf[i].render(scale=RENDER_SCALE).to_pil()
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            pages.append(buf.getvalue())
    finally:
        pdf.close()
    return pages


def pdf_to_text_ocr(data: bytes) -> str:
    pages = []
    for png in pdf_pages_to_png(data):
        try:
            pages.append(image_to_text(png))
        except Unreadable as e:
            if not str(e).startswith("no text was found"):
                raise  # a blank page (a cover, a back side) is skipped; anything else is an error
    if not pages:
        raise Unreadable("no text was found in this scanned PDF")
    return "\n\n".join(pages)
