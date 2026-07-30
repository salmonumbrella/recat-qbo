# Adapted from LevMuchnik/Receiptory at
# 5afac9f01f29a474e1609d364b0ac8584caace13.
# Licensed under AGPL-3.0-only.

from dataclasses import dataclass
from io import BytesIO
import warnings

import pymupdf as fitz
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_EDGE_PIXELS = 4096
MAX_SOURCE_PIXELS = 40_000_000
MAX_RENDERED_BYTES = 40_000_000
SUPPORTED = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/tiff",
}
EXPECTED_IMAGE_FORMAT = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/gif": "GIF",
    "image/tiff": "TIFF",
}


class NormalizeError(ValueError):
    pass


@dataclass(frozen=True)
class RenderedPage:
    content: bytes
    content_type: str
    width: int
    height: int


@dataclass(frozen=True)
class RenderedDocument:
    page_count: int
    pages: tuple[RenderedPage, ...]


def _fit_scale(width: int, height: int) -> float:
    longest = max(width, height)
    return 1 if longest <= MAX_EDGE_PIXELS else MAX_EDGE_PIXELS / longest


def _render_pdf(content: bytes, max_pages: int) -> RenderedDocument:
    try:
        document = fitz.open(stream=content, filetype="pdf")
    except Exception as error:
        raise NormalizeError("Invalid PDF receipt.") from error
    try:
        if document.needs_pass:
            raise NormalizeError("Encrypted PDFs are not supported.")
        if document.page_count < 1:
            raise NormalizeError("PDF has no pages.")
        if document.page_count > max_pages:
            raise NormalizeError("PDF exceeds the configured page limit.")
        rendered: list[RenderedPage] = []
        total = 0
        for page in document:
            rect = page.rect
            scale = _fit_scale(round(rect.width * 2), round(rect.height * 2))
            try:
                pixmap = page.get_pixmap(
                    matrix=fitz.Matrix(2 * scale, 2 * scale),
                    alpha=False,
                )
                payload = pixmap.tobytes("png")
            except Exception as error:
                raise NormalizeError("PDF page rendering failed.") from error
            total += len(payload)
            if total > MAX_RENDERED_BYTES:
                raise NormalizeError(
                    "Document exceeds the rendered payload limit."
                )
            rendered.append(
                RenderedPage(
                    content=payload,
                    content_type="image/png",
                    width=pixmap.width,
                    height=pixmap.height,
                )
            )
        return RenderedDocument(document.page_count, tuple(rendered))
    finally:
        document.close()


def _validate_image(
    content: bytes,
    content_type: str,
) -> None:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as source:
                if source.format != EXPECTED_IMAGE_FORMAT[content_type]:
                    raise NormalizeError(
                        "Declared receipt content type does not match image data."
                    )
                width, height = source.size
                if (
                    width < 1
                    or height < 1
                    or width * height > MAX_SOURCE_PIXELS
                ):
                    raise NormalizeError(
                        "Receipt image exceeds the source pixel limit."
                    )
                source.verify()
    except NormalizeError:
        raise
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        MemoryError,
    ) as error:
        raise NormalizeError(
            "Receipt image exceeds the source pixel limit."
        ) from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise NormalizeError("Invalid image receipt.") from error


def _render_image(content: bytes, content_type: str) -> RenderedDocument:
    _validate_image(content, content_type)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as source:
                source.seek(0)
                image = ImageOps.exif_transpose(source).convert("RGB")
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        MemoryError,
    ) as error:
        raise NormalizeError(
            "Receipt image exceeds the source pixel limit."
        ) from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise NormalizeError("Invalid image receipt.") from error

    try:
        scale = _fit_scale(image.width, image.height)
        if scale < 1:
            resized = image.resize(
                (
                    max(1, round(image.width * scale)),
                    max(1, round(image.height * scale)),
                ),
                Image.Resampling.LANCZOS,
            )
            image.close()
            image = resized
        output = BytesIO()
        image.save(output, format="PNG", optimize=True)
        payload = output.getvalue()
        if len(payload) > MAX_RENDERED_BYTES:
            raise NormalizeError("Document exceeds the rendered payload limit.")
        return RenderedDocument(
            1,
            (
                RenderedPage(
                    payload,
                    "image/png",
                    image.width,
                    image.height,
                ),
            ),
        )
    finally:
        image.close()


def normalize_and_render(
    content: bytes,
    content_type: str,
    max_pages: int,
) -> RenderedDocument:
    if content_type not in SUPPORTED:
        raise NormalizeError("Unsupported receipt content type.")
    if not content:
        raise NormalizeError("Receipt file is empty.")
    if not 1 <= max_pages <= 50:
        raise NormalizeError("Invalid page limit.")
    if content_type == "application/pdf":
        return _render_pdf(content, max_pages)
    return _render_image(content, content_type)
