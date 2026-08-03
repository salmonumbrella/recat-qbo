from __future__ import annotations

from decimal import Decimal
import logging
from types import SimpleNamespace
from typing import Any

import pytest

from conftest import valid_request
from recat_receipt_extractor.contract import ExtractionRequest
from recat_receipt_extractor.cost import estimate_cost
from recat_receipt_extractor import extract
from recat_receipt_extractor.extract import (
    ContentFilteredError,
    ParseFailure,
    TruncatedResponseError,
    build_extraction_prompt,
    completion_kwargs,
    extract_document,
    parse_llm_response,
    reasoning_effort_kwargs,
)
from recat_receipt_extractor.normalize import RenderedPage


def request(**overrides: Any) -> ExtractionRequest:
    return ExtractionRequest.model_validate(valid_request(**overrides))


def pages() -> tuple[RenderedPage, ...]:
    return (RenderedPage(b"synthetic-image", "image/png", 40, 20),)


def response(
    content: object,
    *,
    finish_reason: str = "stop",
    tokens_in: int = 10,
    tokens_out: int = 20,
) -> SimpleNamespace:
    return SimpleNamespace(
        model="synthetic/model",
        usage=SimpleNamespace(
            prompt_tokens=tokens_in,
            completion_tokens=tokens_out,
        ),
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=content),
                finish_reason=finish_reason,
            )
        ],
    )


class FakeCompletions:
    def __init__(self, responses: list[SimpleNamespace]) -> None:
        self.responses = responses
        self.call_count = 0
        self.kwargs: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> SimpleNamespace:
        self.kwargs.append(kwargs)
        result = self.responses[self.call_count]
        self.call_count += 1
        return result


def test_fenced_full_schema_is_salvaged_with_confidence_penalty() -> None:
    raw = """```json
    {"vendor_name":"Synthetic Vendor","total_amount":"11.20",
     "tax_components":[{"label":"Tax A","rate":"0.12","amount":"1.20",
     "confidence":0.9}],"extraction_confidence":0.9}
    ```"""
    result = parse_llm_response(
        raw,
        request_id="synthetic-request",
        model="synthetic/model",
    )
    assert result.parse_salvaged is True
    assert result.document.extraction_confidence == 0.81
    assert result.document.tax_components[0].label == "Tax A"
    assert result.warnings == ("response_json_salvaged",)


def test_line_item_decoy_does_not_replace_document() -> None:
    raw = (
        '{"description":"decoy","quantity":1,"unit_price":1}'
        '\n{"vendor_name":"Synthetic Vendor","total_amount":"10.00"}'
    )
    result = parse_llm_response(
        raw,
        request_id="synthetic-request",
        model="synthetic/model",
    )
    assert result.document.vendor_name == "Synthetic Vendor"


def test_leading_object_ignores_trailing_text_without_salvage() -> None:
    result = parse_llm_response(
        '{"vendor_name":"Synthetic","total_amount":"10"} trailing prose',
        request_id="synthetic-request",
        model="synthetic/model",
    )
    assert result.parse_salvaged is False
    assert result.warnings == ("response_trailing_data_ignored",)


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        '{"vendor_name":"Synthetic"}',
        '{"vendor_name":"Synthetic","total_amount":NaN}',
        '{"vendor_name":"Synthetic","total_amount":"10","unknown":"value"}',
    ],
)
def test_invalid_or_non_finite_shape_is_a_parse_failure(raw: str) -> None:
    with pytest.raises(ParseFailure):
        parse_llm_response(
            raw,
            request_id="synthetic-request",
            model="synthetic/model",
        )


def test_failure_logs_only_metadata(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sensitive_model_text = "MODEL_TEXT_MUST_NOT_BE_LOGGED"
    with caplog.at_level(logging.WARNING):
        with pytest.raises(ParseFailure):
            parse_llm_response(
                sensitive_model_text,
                request_id="synthetic-request",
                model="synthetic/model",
            )
    assert sensitive_model_text not in caplog.text
    assert "request_id=synthetic-request" in caplog.text
    assert "bytes=29" in caplog.text


def test_prompt_preserves_full_schema_and_uses_neutral_tax_components() -> None:
    prompt = build_extraction_prompt(request().business, request().categories)
    for field in [
        "vendor_tax_id",
        "vendor_receipt_id",
        "client_tax_id",
        "raw_extracted_text",
        "document_type",
        "tax_components",
    ]:
        assert field in prompt
    assert "document's own neutral label" in prompt
    assert "jurisdiction-specific tax names or codes" in prompt
    assert prompt.endswith(
        "Return ONLY one JSON object. Do not include markdown fences or explanation."
    )


def test_completion_contains_bounded_vision_payload_without_logging_key() -> None:
    kwargs = completion_kwargs(pages(), request())
    assert kwargs["api_key"] == "request-secret"
    assert kwargs["api_base"] == "https://openrouter.ai/api/v1"
    assert kwargs["extra_headers"] == {
        "HTTP-Referer": "https://recat.example.invalid",
        "X-Title": "Recat",
    }
    assert kwargs["timeout"] == 110
    assert kwargs["response_format"] == {"type": "json_object"}
    image = kwargs["messages"][0]["content"][1]
    assert image["image_url"]["url"].startswith("data:image/png;base64,")


def test_reasoning_effort_is_capability_gated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(extract.litellm, "supports_reasoning", lambda **_: True)
    assert reasoning_effort_kwargs("synthetic/model", "high") == {
        "reasoning_effort": "high",
        "drop_params": True,
    }
    assert reasoning_effort_kwargs("synthetic/model", "none") == {}
    monkeypatch.setattr(extract.litellm, "supports_reasoning", lambda **_: False)
    assert reasoning_effort_kwargs("synthetic/model", "medium") == {}


def test_parse_failure_retries_and_accumulates_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completions = FakeCompletions(
        [
            response("not json", tokens_in=3, tokens_out=4),
            response(
                '{"vendor_name":"Synthetic","total_amount":"10"}',
                tokens_in=5,
                tokens_out=6,
            ),
        ]
    )
    monkeypatch.setattr(extract, "litellm_completion", completions)
    monkeypatch.setattr(
        extract,
        "estimate_cost",
        lambda *_: Decimal("0.25"),
    )
    result = extract_document(pages(), request(parse_retries=1))
    assert result.extraction.vendor_name == "Synthetic"
    assert result.tokens_in == 8
    assert result.tokens_out == 10
    assert result.cost_usd == Decimal("0.25")
    assert completions.call_count == 2


def test_complete_leading_object_is_accepted_at_length_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completions = FakeCompletions(
        [
            response(
                '{"vendor_name":"Synthetic","total_amount":"10"} trailing',
                finish_reason="length",
            )
        ]
    )
    monkeypatch.setattr(extract, "litellm_completion", completions)
    result = extract_document(pages(), request(parse_retries=2))
    assert result.extraction.vendor_name == "Synthetic"
    assert "response_finished_at_token_limit" in result.warnings
    assert completions.call_count == 1


def test_truncated_salvage_does_not_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completions = FakeCompletions(
        [
            response(
                'prefix {"vendor_name":"Synthetic","total_amount":"10"}',
                finish_reason="length",
            ),
            response('{"vendor_name":"wrong","total_amount":"1"}'),
        ]
    )
    monkeypatch.setattr(extract, "litellm_completion", completions)
    with pytest.raises(TruncatedResponseError):
        extract_document(pages(), request(parse_retries=2))
    assert completions.call_count == 1


def test_content_filter_does_not_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completions = FakeCompletions(
        [
            response(None, finish_reason="content_filter"),
            response('{"vendor_name":"wrong","total_amount":"1"}'),
        ]
    )
    monkeypatch.setattr(extract, "litellm_completion", completions)
    with pytest.raises(ContentFilteredError):
        extract_document(pages(), request(parse_retries=2))
    assert completions.call_count == 1


def test_cost_uses_litellm_and_has_a_decimal_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "recat_receipt_extractor.cost.litellm.cost_per_token",
        lambda **_: (0.01, 0.02),
    )
    assert estimate_cost("synthetic/model", 1, 1) == Decimal("0.03")

    def unavailable(**_: Any) -> None:
        raise RuntimeError("synthetic lookup failure")

    monkeypatch.setattr(
        "recat_receipt_extractor.cost.litellm.cost_per_token",
        unavailable,
    )
    assert estimate_cost("unknown/model", 10, 20) == Decimal("0.00007")
