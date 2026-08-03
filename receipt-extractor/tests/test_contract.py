from decimal import Decimal

from pydantic import ValidationError
import pytest

from recat_receipt_extractor.contract import (
    ExtractionRequest,
    ExtractionResponse,
)
from conftest import valid_request


def test_request_is_strict_and_bounded() -> None:
    request = ExtractionRequest.model_validate(valid_request())
    assert request.max_pages == 20
    with pytest.raises(ValidationError):
        ExtractionRequest.model_validate({**valid_request(), "max_pages": 51})
    with pytest.raises(ValidationError):
        ExtractionRequest.model_validate({**valid_request(), "extra": True})


@pytest.mark.parametrize("value", [float("nan"), "Infinity", Decimal("-Infinity")])
def test_response_rejects_non_finite_money(value: object) -> None:
    with pytest.raises(ValidationError):
        ExtractionResponse.model_validate(
            {
                "schema_version": "recat-receipt-extraction/v1",
                "prompt_version": "receiptory-5afac9f0+recat-tax-components-v1",
                "page_count": 1,
                "extraction": {"total_amount": value},
                "parse_salvaged": False,
                "warnings": [],
                "model": "synthetic/model",
                "tokens_in": 0,
                "tokens_out": 0,
                "cost_usd": 0,
                "duration_ms": 1,
            }
        )


def test_full_receiptory_shape_and_neutral_tax_components_validate() -> None:
    result = ExtractionResponse.model_validate(
        {
            "schema_version": "recat-receipt-extraction/v1",
            "prompt_version": "receiptory-5afac9f0+recat-tax-components-v1",
            "page_count": 1,
            "extraction": {
                "receipt_date": "2026-07-30",
                "document_title": "Synthetic document",
                "vendor_name": "Synthetic Vendor",
                "vendor_tax_id": "synthetic-id",
                "vendor_receipt_id": "synthetic-receipt",
                "client_name": "Synthetic Client",
                "client_tax_id": "synthetic-client-id",
                "description": "Synthetic purchase",
                "line_items": [
                    {
                        "description": "Synthetic item",
                        "quantity": "2",
                        "unit_price": "5.00",
                    }
                ],
                "subtotal": "10.00",
                "tax_amount": "1.20",
                "total_amount": "11.20",
                "currency": "USD",
                "payment_method": "card",
                "payment_identifier": "0000",
                "language": "en",
                "additional_fields": [{"key": "Reference", "value": "Synthetic"}],
                "raw_extracted_text": "Synthetic text",
                "document_type": "expense_receipt",
                "category": "Synthetic category",
                "extraction_confidence": 0.9,
                "tax_components": [
                    {
                        "label": "Tax A",
                        "rate": "0.12",
                        "amount": "1.20",
                        "confidence": 0.9,
                    }
                ],
            },
            "parse_salvaged": False,
            "warnings": [],
            "model": "synthetic/model",
            "tokens_in": 10,
            "tokens_out": 20,
            "cost_usd": "0.00007",
            "duration_ms": 5,
        }
    )
    assert result.extraction.tax_components[0].label == "Tax A"
