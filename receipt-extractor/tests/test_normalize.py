from io import BytesIO

import pymupdf as fitz
from PIL import Image
import pytest

from recat_receipt_extractor import normalize
from recat_receipt_extractor.normalize import (
    NormalizeError,
    normalize_and_render,
)


def synthetic_png(width: int = 40, height: int = 20) -> bytes:
    source = BytesIO()
    Image.new("RGB", (width, height), "white").save(source, format="PNG")
    return source.getvalue()


def test_png_normalizes_to_one_rendered_page() -> None:
    result = normalize_and_render(
        synthetic_png(),
        "image/png",
        max_pages=20,
    )
    assert result.page_count == 1
    assert result.pages[0].content_type == "image/png"
    assert max(result.pages[0].width, result.pages[0].height) <= 4096


def test_large_image_is_bounded_to_maximum_edge() -> None:
    result = normalize_and_render(
        synthetic_png(width=5000, height=10),
        "image/png",
        max_pages=20,
    )
    assert result.pages[0].width == 4096


def test_source_pixel_count_is_rejected_before_decode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(normalize, "MAX_SOURCE_PIXELS", 10)
    with pytest.raises(NormalizeError, match="pixel limit"):
        normalize_and_render(synthetic_png(), "image/png", max_pages=20)


def test_declared_image_type_must_match_detected_format() -> None:
    with pytest.raises(NormalizeError, match="does not match"):
        normalize_and_render(synthetic_png(), "image/jpeg", max_pages=20)


def test_pillow_decompression_bomb_is_a_stable_normalize_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def bomb(*_: object, **__: object) -> object:
        raise Image.DecompressionBombError("private dimensions")

    monkeypatch.setattr(normalize.Image, "open", bomb)
    with pytest.raises(NormalizeError, match="pixel limit"):
        normalize_and_render(synthetic_png(), "image/png", max_pages=20)


def test_pdf_over_page_limit_is_rejected() -> None:
    document = fitz.open()
    for _ in range(3):
        document.new_page()
    try:
        content = document.tobytes()
    finally:
        document.close()

    with pytest.raises(NormalizeError, match="page limit"):
        normalize_and_render(content, "application/pdf", max_pages=2)


def test_rendered_payload_over_40_mb_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(normalize, "MAX_RENDERED_BYTES", 10)
    with pytest.raises(NormalizeError, match="rendered payload"):
        normalize_and_render(synthetic_png(), "image/png", max_pages=20)


@pytest.mark.parametrize(
    "content_type",
    ["text/plain", "image/webp", "image/svg+xml"],
)
def test_unsupported_type_is_rejected(content_type: str) -> None:
    with pytest.raises(NormalizeError, match="Unsupported"):
        normalize_and_render(b"synthetic", content_type, max_pages=20)


def test_empty_and_invalid_inputs_are_stable_errors() -> None:
    with pytest.raises(NormalizeError, match="empty"):
        normalize_and_render(b"", "image/png", max_pages=20)
    with pytest.raises(NormalizeError, match="Invalid image"):
        normalize_and_render(b"not-an-image", "image/png", max_pages=20)
    with pytest.raises(NormalizeError, match="Invalid page limit"):
        normalize_and_render(synthetic_png(), "image/png", max_pages=0)
