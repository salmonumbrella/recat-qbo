# Adapted from LevMuchnik/Receiptory at
# 5afac9f01f29a474e1609d364b0ac8584caace13.
# Licensed under AGPL-3.0-only.

from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field


def finite_decimal(value: Decimal) -> Decimal:
    if not value.is_finite():
        raise ValueError("decimal value must be finite")
    return value


BoundedText = Annotated[str, Field(max_length=10_000)]
FiniteDecimal = Annotated[Decimal, AfterValidator(finite_decimal)]
Money = FiniteDecimal | None
HeaderName = Annotated[
    str,
    Field(
        min_length=1,
        max_length=100,
        pattern=r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$",
    ),
]
HeaderValue = Annotated[
    str,
    Field(max_length=2_000, pattern=r"^[^\r\n]*$"),
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BusinessContext(StrictModel):
    names: list[Annotated[str, Field(max_length=500)]] = Field(max_length=20)
    addresses: list[Annotated[str, Field(max_length=1000)]] = Field(max_length=20)
    tax_ids: list[Annotated[str, Field(max_length=200)]] = Field(max_length=20)


class CategoryOption(StrictModel):
    name: Annotated[str, Field(min_length=1, max_length=500)]
    description: Annotated[str, Field(max_length=1000)] = ""


class CategoryContext(StrictModel):
    expense: list[CategoryOption] = Field(max_length=500)
    issued: list[CategoryOption] = Field(max_length=500)


class ExtractionRequest(StrictModel):
    request_id: UUID
    model: Annotated[str, Field(min_length=1, max_length=200)]
    api_base: Annotated[str, Field(min_length=1, max_length=2000)]
    api_key: Annotated[str, Field(min_length=1, max_length=4096)]
    provider_headers: dict[HeaderName, HeaderValue] = Field(
        default_factory=dict,
        max_length=20,
    )
    temperature: float = Field(ge=0, le=2)
    max_tokens: int = Field(ge=256, le=32768)
    parse_retries: int = Field(ge=0, le=5)
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high"]
    max_pages: int = Field(ge=1, le=50)
    business: BusinessContext
    categories: CategoryContext


class LineItem(StrictModel):
    description: Annotated[str, Field(max_length=2000)]
    quantity: FiniteDecimal | None = None
    unit_price: Money = None


class AdditionalField(StrictModel):
    key: Annotated[str, Field(max_length=500)]
    value: Annotated[str, Field(max_length=5000)]


class TaxComponent(StrictModel):
    label: Annotated[str, Field(max_length=200)]
    rate: FiniteDecimal | None = None
    amount: Money = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class ExtractedDocument(StrictModel):
    receipt_date: str | None = Field(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    )
    document_title: BoundedText | None = None
    vendor_name: BoundedText | None = None
    vendor_tax_id: Annotated[str, Field(max_length=200)] | None = None
    vendor_receipt_id: Annotated[str, Field(max_length=200)] | None = None
    client_name: BoundedText | None = None
    client_tax_id: Annotated[str, Field(max_length=200)] | None = None
    description: BoundedText | None = None
    line_items: list[LineItem] = Field(default_factory=list, max_length=1000)
    subtotal: Money = None
    tax_amount: Money = None
    total_amount: Money = None
    currency: Annotated[str, Field(pattern=r"^[A-Z]{3}$")] | None = None
    payment_method: Annotated[str, Field(max_length=80)] | None = None
    payment_identifier: Annotated[str, Field(max_length=200)] | None = None
    language: Annotated[str, Field(max_length=16)] | None = None
    additional_fields: list[AdditionalField] = Field(
        default_factory=list,
        max_length=200,
    )
    raw_extracted_text: Annotated[str, Field(max_length=200_000)] | None = None
    document_type: Annotated[str, Field(max_length=80)] | None = None
    category: Annotated[str, Field(max_length=500)] | None = None
    extraction_confidence: float | None = Field(default=None, ge=0, le=1)
    tax_components: list[TaxComponent] = Field(
        default_factory=list,
        max_length=20,
    )


class ExtractionResponse(StrictModel):
    schema_version: Literal["recat-receipt-extraction/v1"]
    prompt_version: Literal["receiptory-5afac9f0+recat-tax-components-v1"]
    page_count: int = Field(ge=1, le=50)
    extraction: ExtractedDocument
    parse_salvaged: bool
    warnings: list[Annotated[str, Field(max_length=500)]] = Field(max_length=100)
    model: Annotated[str, Field(max_length=200)]
    tokens_in: int = Field(ge=0)
    tokens_out: int = Field(ge=0)
    cost_usd: Annotated[FiniteDecimal, Field(ge=0)]
    duration_ms: int = Field(ge=0)
