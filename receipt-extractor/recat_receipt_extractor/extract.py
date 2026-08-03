# Adapted from LevMuchnik/Receiptory at
# 5afac9f01f29a474e1609d364b0ac8584caace13.
# Licensed under AGPL-3.0-only.

from __future__ import annotations

import base64
from dataclasses import dataclass
import json
import logging
import re
import time
from typing import Any

import litellm
from pydantic import ValidationError

from .contract import (
    BusinessContext,
    CategoryContext,
    ExtractedDocument,
    ExtractionRequest,
    ExtractionResponse,
)
from .cost import estimate_cost
from .normalize import RenderedPage

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "recat-receipt-extraction/v1"
PROMPT_VERSION = "receiptory-5afac9f0+recat-tax-components-v1"
EXPECTED_KEYS = frozenset(
    {
        "receipt_date",
        "document_title",
        "vendor_name",
        "vendor_tax_id",
        "vendor_receipt_id",
        "client_name",
        "client_tax_id",
        "description",
        "line_items",
        "subtotal",
        "tax_amount",
        "total_amount",
        "currency",
        "payment_method",
        "payment_identifier",
        "language",
        "additional_fields",
        "raw_extracted_text",
        "document_type",
        "category",
        "extraction_confidence",
        "tax_components",
    }
)
SALVAGE_CONFIDENCE_FACTOR = 0.9
MAX_SALVAGE_ATTEMPTS = 1000
MAX_PARSE_RETRIES = 5
_JSON_DECODER = json.JSONDecoder()
_FENCE_OPEN_RE = re.compile(r"```(?:json)?", re.IGNORECASE)

TAX_COMPONENT_INSTRUCTION = """
- tax_components: array of tax components visible on the document. Each item:
  {"label": the document's own neutral label, "rate": decimal fraction or null,
   "amount": numeric amount or null, "confidence": 0.0 to 1.0 or null}.
  Do not invent jurisdiction-specific tax names or codes. Preserve the label
  printed on the document. Use [] when no component is visible.
""".strip()


class ParseFailure(ValueError):
    pass


class TruncatedResponseError(ValueError):
    pass


class ContentFilteredError(ValueError):
    pass


class ProviderResponseError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedExtraction:
    document: ExtractedDocument
    parse_salvaged: bool
    warnings: tuple[str, ...]


def _decode_leading_object(
    text: str,
    start: int = 0,
) -> tuple[dict[str, Any], str] | None:
    while start < len(text) and text[start].isspace():
        start += 1
    try:
        data, end = _JSON_DECODER.raw_decode(text, start)
    except (json.JSONDecodeError, RecursionError):
        return None
    if not isinstance(data, dict):
        return None
    if len(EXPECTED_KEYS.intersection(data)) < 2:
        return None
    return data, text[end:]


def _validate_document(
    payload: dict[str, Any],
    *,
    request_id: str,
    model: str,
    response_bytes: int,
    tier: str,
) -> ExtractedDocument:
    try:
        return ExtractedDocument.model_validate(payload)
    except ValidationError as error:
        logger.warning(
            "extract schema rejected request_id=%s model=%s bytes=%d tier=%s",
            request_id,
            model,
            response_bytes,
            tier,
        )
        raise ParseFailure(
            "Model output did not match the extraction schema."
        ) from error


def parse_llm_response(
    response_text: str,
    *,
    request_id: str,
    model: str,
) -> ParsedExtraction:
    text = response_text.strip()
    response_bytes = len(response_text.encode("utf-8"))
    salvaged = False
    tier = "leading"
    decoded = _decode_leading_object(text)

    if decoded is None:
        best: tuple[dict[str, Any], str] | None = None
        best_matched = 0
        fence = _FENCE_OPEN_RE.search(text)
        fence_candidate = (
            _decode_leading_object(text, fence.end()) if fence else None
        )
        if fence_candidate is not None:
            best = fence_candidate
            best_matched = len(EXPECTED_KEYS.intersection(fence_candidate[0]))
        index = text.find("{")
        attempts = 0
        while index != -1 and attempts < MAX_SALVAGE_ATTEMPTS:
            candidate = _decode_leading_object(text, index)
            attempts += 1
            if candidate is not None:
                matched = len(EXPECTED_KEYS.intersection(candidate[0]))
                if matched > best_matched:
                    best = candidate
                    best_matched = matched
            index = text.find("{", index + 1)
        if best is not None:
            decoded = best
            salvaged = True
            tier = "fence" if best is fence_candidate else "scan"
            logger.warning(
                "extract response salvaged request_id=%s model=%s bytes=%d tier=%s",
                request_id,
                model,
                response_bytes,
                tier,
            )

    if decoded is None:
        logger.warning(
            "extract parse failed request_id=%s model=%s bytes=%d tier=%s",
            request_id,
            model,
            response_bytes,
            "salvage",
        )
        raise ParseFailure("Model output was not a valid extraction object.")

    payload, trailing = decoded
    warnings: list[str] = []
    if salvaged:
        warnings.append("response_json_salvaged")
    trailing = trailing.strip()
    if trailing.startswith("```"):
        trailing = trailing.removeprefix("```").strip()
    if trailing:
        warnings.append("response_trailing_data_ignored")
        logger.warning(
            "extract trailing data ignored request_id=%s model=%s bytes=%d tier=%s",
            request_id,
            model,
            response_bytes,
            tier,
        )

    document = _validate_document(
        payload,
        request_id=request_id,
        model=model,
        response_bytes=response_bytes,
        tier=tier,
    )
    if salvaged and document.extraction_confidence is not None:
        document = document.model_copy(
            update={
                "extraction_confidence": round(
                    document.extraction_confidence
                    * SALVAGE_CONFIDENCE_FACTOR,
                    4,
                )
            }
        )
    return ParsedExtraction(document, salvaged, tuple(warnings))


def build_extraction_prompt(
    business: BusinessContext,
    categories: CategoryContext,
) -> str:
    expense_categories = json.dumps(
        [category.model_dump() for category in categories.expense],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    issued_categories = json.dumps(
        [category.model_dump() for category in categories.issued],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"""You are a document data extraction system. Analyze the provided document image(s) and extract all structured data.

## User business context
- Business names: {json.dumps(business.names, ensure_ascii=False)}
- Business addresses: {json.dumps(business.addresses, ensure_ascii=False)}
- Business tax IDs: {json.dumps(business.tax_ids, ensure_ascii=False)}

If the document issuer matches that context, classify it as issued_invoice.
Otherwise classify a financial document as expense_receipt and a non-financial
document as other_document.

## Expense categories
{expense_categories}

## Issued document categories
{issued_categories}

Pick a category only from the appropriate list.

## Required output
Return a single JSON object with these fields:
- receipt_date: YYYY-MM-DD or null
- document_title: title printed on the document or null
- vendor_name: vendor or issuer name or null
- vendor_tax_id: issuer tax identifier or null
- vendor_receipt_id: receipt or invoice identifier or null
- client_name: client or buyer name or null
- client_tax_id: client or buyer tax identifier or null
- description: concise document summary or null
- line_items: array of {{"description": string, "quantity": number or null, "unit_price": number or null}}
- subtotal: pre-tax amount or null
- tax_amount: total tax amount or null
- total_amount: total amount or null
- currency: ISO 4217 code or null
- payment_method: payment method or null
- payment_identifier: masked payment identifier or null
- language: detected language code or null
- additional_fields: array of {{"key": string, "value": string}}
- raw_extracted_text: full visible document text or null
- document_type: expense_receipt, issued_invoice, or other_document
- category: one category name from the appropriate list or null
- extraction_confidence: number from 0.0 to 1.0 or null
{TAX_COMPONENT_INSTRUCTION}

Return ONLY one JSON object. Do not include markdown fences or explanation."""


def page_data_url(page: RenderedPage) -> str:
    encoded = base64.b64encode(page.content).decode("ascii")
    return f"data:{page.content_type};base64,{encoded}"


def reasoning_effort_kwargs(model: str, effort: str) -> dict[str, Any]:
    if effort == "none":
        return {}
    try:
        if not litellm.supports_reasoning(model=model):
            return {}
    except Exception:
        return {}
    return {"reasoning_effort": effort, "drop_params": True}


def completion_kwargs(
    pages: tuple[RenderedPage, ...],
    request: ExtractionRequest,
) -> dict[str, Any]:
    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": build_extraction_prompt(
                request.business,
                request.categories,
            ),
        }
    ]
    content.extend(
        {
            "type": "image_url",
            "image_url": {
                "url": page_data_url(page),
                "detail": "high",
            },
        }
        for page in pages
    )
    result: dict[str, Any] = {
        "model": request.model,
        "api_key": request.api_key,
        "api_base": request.api_base,
        "messages": [{"role": "user", "content": content}],
        "temperature": request.temperature,
        "max_tokens": request.max_tokens,
        "response_format": {"type": "json_object"},
        "drop_params": True,
        "timeout": 110,
    }
    result.update(
        reasoning_effort_kwargs(request.model, request.reasoning_effort)
    )
    return result


def litellm_completion(**kwargs: Any) -> Any:
    return litellm.completion(**kwargs)


def _usage_value(usage: Any, field: str) -> int:
    value = getattr(usage, field, 0) or 0
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def extract_document(
    pages: tuple[RenderedPage, ...],
    request: ExtractionRequest,
) -> ExtractionResponse:
    if not pages or len(pages) > request.max_pages:
        raise ValueError("Rendered page count is outside the request bounds.")
    started = time.monotonic()
    kwargs = completion_kwargs(pages, request)
    tokens_in = 0
    tokens_out = 0

    for attempt in range(min(request.parse_retries, MAX_PARSE_RETRIES) + 1):
        response = litellm_completion(**kwargs)
        usage = getattr(response, "usage", None)
        tokens_in += _usage_value(usage, "prompt_tokens")
        tokens_out += _usage_value(usage, "completion_tokens")
        choices = getattr(response, "choices", None)
        if not isinstance(choices, list) or not choices:
            raise ProviderResponseError("Provider returned no completion choice.")
        choice = choices[0]
        finish_reason = getattr(choice, "finish_reason", None)
        raw_content = getattr(getattr(choice, "message", None), "content", None)
        if finish_reason == "content_filter":
            raise ContentFilteredError("Provider filtered the receipt response.")
        if raw_content is None or raw_content == "":
            raise ProviderResponseError("Provider returned an empty response.")
        if not isinstance(raw_content, str):
            raise ProviderResponseError(
                "Provider returned an unexpected response type."
            )
        try:
            parsed = parse_llm_response(
                raw_content,
                request_id=str(request.request_id),
                model=request.model,
            )
        except ParseFailure:
            if finish_reason == "length":
                raise TruncatedResponseError(
                    "Provider response was truncated before a complete extraction."
                )
            if attempt < request.parse_retries:
                logger.warning(
                    "extract parse retry request_id=%s model=%s bytes=%d tier=%s",
                    request.request_id,
                    request.model,
                    len(raw_content.encode("utf-8")),
                    "retry",
                )
                continue
            raise

        warnings = list(parsed.warnings)
        if finish_reason == "length":
            if parsed.parse_salvaged:
                raise TruncatedResponseError(
                    "Provider response was truncated before a complete extraction."
                )
            warnings.append("response_finished_at_token_limit")
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        return ExtractionResponse(
            schema_version=SCHEMA_VERSION,
            prompt_version=PROMPT_VERSION,
            page_count=len(pages),
            extraction=parsed.document,
            parse_salvaged=parsed.parse_salvaged,
            warnings=warnings,
            model=request.model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=estimate_cost(request.model, tokens_in, tokens_out),
            duration_ms=duration_ms,
        )
    raise RuntimeError("Extraction retry loop exited unexpectedly.")
