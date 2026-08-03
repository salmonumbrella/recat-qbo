import asyncio
from decimal import Decimal
from io import BytesIO
import json
import logging
from unittest.mock import Mock

from fastapi.testclient import TestClient
import httpx
from litellm.exceptions import (
    BlockedPiiEntityError,
    BudgetExceededError,
    GuardrailRaisedException,
)
from PIL import Image
import pytest

from conftest import valid_request
from recat_receipt_extractor import app
from recat_receipt_extractor.app import create_app, process_upload
from recat_receipt_extractor.contract import ExtractedDocument, ExtractionResponse
from recat_receipt_extractor.normalize import (
    NormalizeError,
    RenderedDocument,
    RenderedPage,
)


def test_encoded_multipart_limit_is_exactly_one_hundred_megabytes() -> None:
    assert app.MAX_REQUEST_BYTES == 100_000_000


def test_health_has_no_provider_dependency() -> None:
    response = TestClient(create_app(service_token="secret")).get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_extract_requires_constant_service_token() -> None:
    client = TestClient(create_app(service_token="secret"))
    response = client.post(
        "/v1/extract",
        files={"file": ("synthetic.png", b"not-used", "image/png")},
        data={"request": "{}"},
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized"}


def test_auth_rejects_before_multipart_parsing() -> None:
    client = TestClient(create_app(service_token="secret"))
    response = client.post(
        "/v1/extract",
        headers={"Content-Type": "multipart/form-data; boundary=broken"},
        content=b"malformed multipart without a boundary terminator",
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized"}


def test_whole_request_limit_rejects_before_multipart_parsing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "MAX_REQUEST_BYTES", 10)
    client = TestClient(create_app(service_token="secret"))
    response = client.post(
        "/v1/extract",
        headers={
            "X-Recat-Extractor-Token": "secret",
            "Content-Type": "multipart/form-data; boundary=broken",
        },
        content=b"12345678901",
    )
    assert response.status_code == 413
    assert response.json()["code"] == "RECEIPT_REQUEST_TOO_LARGE"


def test_streamed_request_limit_does_not_require_content_length(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "MAX_REQUEST_BYTES", 10)
    client = TestClient(create_app(service_token="secret"))
    response = client.post(
        "/v1/extract",
        headers={
            "X-Recat-Extractor-Token": "secret",
            "Content-Type": "multipart/form-data; boundary=broken",
        },
        content=iter([b"123456", b"78901"]),
    )
    assert response.status_code == 413
    assert response.json()["code"] == "RECEIPT_REQUEST_TOO_LARGE"


def synthetic_png() -> bytes:
    source = BytesIO()
    Image.new("RGB", (40, 20), "white").save(source, format="PNG")
    return source.getvalue()


def fake_render(
    content: bytes,
    content_type: str,
    max_pages: int,
) -> RenderedDocument:
    assert content
    assert content_type == "image/png"
    assert max_pages == 20
    return RenderedDocument(
        1,
        (RenderedPage(b"rendered", "image/png", 40, 20),),
    )


def fake_extract(
    pages: tuple[RenderedPage, ...],
    request: object,
) -> ExtractionResponse:
    assert len(pages) == 1
    return ExtractionResponse(
        schema_version="recat-receipt-extraction/v1",
        prompt_version="receiptory-5afac9f0+recat-tax-components-v1",
        page_count=1,
        extraction=ExtractedDocument(
            vendor_name="Synthetic Vendor",
            total_amount=Decimal("10.00"),
        ),
        parse_salvaged=False,
        warnings=[],
        model="synthetic/model",
        tokens_in=1,
        tokens_out=1,
        cost_usd=Decimal("0.000004"),
        duration_ms=1,
    )


def authorized_extract(
    client: TestClient,
    *,
    content: bytes | None = None,
    request_body: dict[str, object] | None = None,
) -> object:
    return client.post(
        "/v1/extract",
        headers={"X-Recat-Extractor-Token": "secret"},
        data={"request": json.dumps(request_body or valid_request())},
        files={
            "file": (
                "synthetic.png",
                content if content is not None else synthetic_png(),
                "image/png",
            )
        },
    )


def test_extract_normalizes_and_returns_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "normalize_and_render", fake_render)
    monkeypatch.setattr(app, "extract_document", fake_extract)
    client = TestClient(create_app(service_token="secret", process=process_upload))

    response = authorized_extract(client)

    assert response.status_code == 200
    assert response.json()["schema_version"] == "recat-receipt-extraction/v1"
    assert response.json()["extraction"]["total_amount"] == "10.00"


def test_normalization_and_extraction_both_leave_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[object] = []

    async def fake_to_thread(function: object, *args: object) -> object:
        calls.append(function)
        return function(*args)  # type: ignore[operator]

    monkeypatch.setattr(app, "normalize_and_render", fake_render)
    monkeypatch.setattr(app, "extract_document", fake_extract)
    monkeypatch.setattr(app.asyncio, "to_thread", fake_to_thread)
    client = TestClient(create_app(service_token="secret", process=process_upload))

    response = authorized_extract(client)

    assert response.status_code == 200
    assert calls == [fake_render, fake_extract]


def test_authenticated_extraction_pipeline_has_a_concurrency_gate() -> None:
    active = 0
    maximum_active = 0

    async def blocked_process(*_: object) -> ExtractionResponse:
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        await asyncio.sleep(0.02)
        active -= 1
        return fake_extract(RenderedDocument(
            1,
            (RenderedPage(b"rendered", "image/png", 40, 20),),
        ).pages, object())

    async def run_requests() -> None:
        transport = httpx.ASGITransport(
            app=create_app(service_token="secret", process=blocked_process)
        )
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            async def post() -> httpx.Response:
                return await client.post(
                    "/v1/extract",
                    headers={"X-Recat-Extractor-Token": "secret"},
                    data={"request": json.dumps(valid_request())},
                    files={
                        "file": (
                            "synthetic.png",
                            synthetic_png(),
                            "image/png",
                        )
                    },
                )

            responses = await asyncio.gather(post(), post())
            assert [response.status_code for response in responses] == [200, 200]

    asyncio.run(run_requests())
    assert maximum_active == 1


def test_page_limit_has_stable_error_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        app,
        "normalize_and_render",
        Mock(
            side_effect=NormalizeError(
                "PDF exceeds the configured page limit."
            )
        ),
    )
    client = TestClient(create_app(service_token="secret", process=process_upload))

    response = authorized_extract(client)

    assert response.status_code == 422
    assert response.json() == {
        "code": "RECEIPT_PAGE_LIMIT",
        "message": "PDF exceeds the configured page limit.",
        "transient": False,
    }


def test_input_and_response_byte_limits_have_stable_codes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = TestClient(create_app(service_token="secret", process=process_upload))
    monkeypatch.setattr(app, "MAX_INPUT_BYTES", 5)
    response = authorized_extract(client, content=b"123456")
    assert response.status_code == 413
    assert response.json()["code"] == "RECEIPT_INPUT_TOO_LARGE"

    monkeypatch.setattr(app, "MAX_INPUT_BYTES", 100_000_000)
    monkeypatch.setattr(app, "MAX_RESPONSE_BYTES", 10)
    monkeypatch.setattr(app, "normalize_and_render", fake_render)
    monkeypatch.setattr(app, "extract_document", fake_extract)
    response = authorized_extract(client)
    assert response.status_code == 502
    assert response.json()["code"] == "RECEIPT_RESPONSE_TOO_LARGE"


def test_invalid_request_has_no_validation_or_file_content_details() -> None:
    client = TestClient(create_app(service_token="secret", process=process_upload))
    response = client.post(
        "/v1/extract",
        headers={"X-Recat-Extractor-Token": "secret"},
        data={"request": "{not-json"},
        files={
            "file": (
                "private-filename.png",
                b"PRIVATE_FILE_BYTES",
                "image/png",
            )
        },
    )
    assert response.status_code == 422
    assert response.json() == {
        "code": "RECEIPT_REQUEST_INVALID",
        "message": "Extraction request is invalid.",
        "transient": False,
    }
    assert "private-filename" not in response.text
    assert "PRIVATE_FILE_BYTES" not in response.text


def test_form_validation_failure_is_stable_and_does_not_echo_private_input() -> None:
    private_request = "PRIVATE_API_KEY_SENTINEL_" + ("x" * 100_000)
    private_file = b"PRIVATE_FILE_SENTINEL"
    client = TestClient(create_app(service_token="secret", process=process_upload))
    response = client.post(
        "/v1/extract",
        headers={"X-Recat-Extractor-Token": "secret"},
        data={"request": private_request},
        files={
            "file": (
                "private-filename.png",
                private_file,
                "image/png",
            )
        },
    )
    assert response.status_code == 422
    assert response.json() == {
        "code": "RECEIPT_REQUEST_INVALID",
        "message": "Extraction request is invalid.",
        "transient": False,
    }
    assert "PRIVATE_API_KEY_SENTINEL" not in response.text
    assert "PRIVATE_FILE_SENTINEL" not in response.text
    assert "private-filename" not in response.text


def test_failure_logging_contains_metadata_only(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    private_bytes = b"PRIVATE_RECEIPT_BYTES"
    monkeypatch.setattr(
        app,
        "normalize_and_render",
        Mock(side_effect=NormalizeError("Invalid image receipt.")),
    )
    client = TestClient(create_app(service_token="secret", process=process_upload))
    with caplog.at_level(logging.WARNING):
        response = authorized_extract(client, content=private_bytes)
    assert response.status_code == 422
    assert "PRIVATE_RECEIPT_BYTES" not in caplog.text
    assert "request_id=1f6d26c2-7332-4eb0-b93d-18d3ea625a30" in caplog.text
    assert "code=RECEIPT_INVALID_FILE" in caplog.text


def test_litellm_content_policy_violation_is_permanent_and_sanitized(
    caplog: pytest.LogCaptureFixture,
) -> None:
    private_provider_message = "PRIVATE_PROVIDER_POLICY_DETAIL"

    async def rejected(*_: object) -> object:
        raise app.litellm.ContentPolicyViolationError(
            message=private_provider_message,
            model="synthetic/model",
            llm_provider="synthetic",
        )

    client = TestClient(create_app(service_token="secret", process=rejected))
    with caplog.at_level(logging.WARNING):
        response = authorized_extract(client)
    assert response.status_code == 422
    assert response.json() == {
        "code": "RECEIPT_CONTENT_FILTERED",
        "message": "Provider filtered the receipt response.",
        "transient": False,
    }
    assert private_provider_message not in response.text
    assert private_provider_message not in caplog.text


@pytest.mark.parametrize(
    ("provider_error", "status_code", "code", "message"),
    [
        (
            app.litellm.ContextWindowExceededError(
                message="PRIVATE_PROVIDER_CONTEXT_DETAIL",
                model="synthetic/model",
                llm_provider="synthetic",
            ),
            422,
            "RECEIPT_PROVIDER_CONTEXT_LIMIT",
            "Receipt exceeds the provider context limit.",
        ),
        (
            app.litellm.UnsupportedParamsError(
                message="PRIVATE_PROVIDER_UNSUPPORTED_DETAIL",
                model="synthetic/model",
                llm_provider="synthetic",
            ),
            502,
            "RECEIPT_PROVIDER_CONFIG",
            "Provider configuration is invalid.",
        ),
        (
            app.litellm.NotFoundError(
                message="PRIVATE_PROVIDER_NOT_FOUND_DETAIL",
                model="synthetic/model",
                llm_provider="synthetic",
            ),
            502,
            "RECEIPT_PROVIDER_CONFIG",
            "Provider configuration is invalid.",
        ),
        (
            app.litellm.PermissionDeniedError(
                message="PRIVATE_PROVIDER_PERMISSION_DETAIL",
                model="synthetic/model",
                llm_provider="synthetic",
                response=httpx.Response(
                    403,
                    request=httpx.Request(
                        "POST",
                        "https://provider.invalid/v1/extract",
                    ),
                ),
            ),
            502,
            "RECEIPT_PROVIDER_AUTH",
            "Provider authentication failed.",
        ),
        (
            app.litellm.BadRequestError(
                message="PRIVATE_PROVIDER_BAD_REQUEST_DETAIL",
                model="synthetic/model",
                llm_provider="synthetic",
            ),
            502,
            "RECEIPT_PROVIDER_CONFIG",
            "Provider configuration is invalid.",
        ),
        (
            app.litellm.UnprocessableEntityError(
                message="PRIVATE_PROVIDER_UNPROCESSABLE_DETAIL",
                model="synthetic/model",
                llm_provider="synthetic",
                response=httpx.Response(
                    422,
                    request=httpx.Request(
                        "POST",
                        "https://provider.invalid/v1/extract",
                    ),
                ),
            ),
            502,
            "RECEIPT_PROVIDER_CONFIG",
            "Provider configuration is invalid.",
        ),
        (
            BudgetExceededError(
                current_cost=2,
                max_budget=1,
                message="PRIVATE_PROVIDER_BUDGET_DETAIL",
            ),
            502,
            "RECEIPT_PROVIDER_BUDGET",
            "Provider budget was exceeded.",
        ),
        (
            BlockedPiiEntityError(
                entity_type="PRIVATE_PROVIDER_BLOCKED_DETAIL",
                guardrail_name="synthetic",
            ),
            422,
            "RECEIPT_CONTENT_FILTERED",
            "Provider filtered the receipt response.",
        ),
        (
            GuardrailRaisedException(
                guardrail_name="synthetic",
                message="PRIVATE_PROVIDER_GUARDRAIL_DETAIL",
            ),
            422,
            "RECEIPT_CONTENT_FILTERED",
            "Provider filtered the receipt response.",
        ),
    ],
)
def test_permanent_litellm_errors_are_sanitized_and_not_retryable(
    provider_error: Exception,
    status_code: int,
    code: str,
    message: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    private_provider_message = str(provider_error)

    async def rejected(*_: object) -> object:
        raise provider_error

    client = TestClient(create_app(service_token="secret", process=rejected))
    with caplog.at_level(logging.WARNING):
        response = authorized_extract(client)

    assert response.status_code == status_code
    assert response.json() == {
        "code": code,
        "message": message,
        "transient": False,
    }
    assert private_provider_message not in response.text
    assert private_provider_message not in caplog.text
