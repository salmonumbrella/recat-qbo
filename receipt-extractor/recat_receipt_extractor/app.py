# Adapted from LevMuchnik/Receiptory at
# 5afac9f01f29a474e1609d364b0ac8584caace13.
# Licensed under AGPL-3.0-only.

import asyncio
from dataclasses import dataclass
import hmac
import json
import logging
import os
import tempfile
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import litellm
from litellm.exceptions import (
    BlockedPiiEntityError,
    BudgetExceededError,
    GuardrailRaisedException,
)
from pydantic import ValidationError
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .contract import ExtractionRequest, ExtractionResponse
from .extract import (
    ContentFilteredError,
    ParseFailure,
    ProviderResponseError,
    TruncatedResponseError,
    extract_document,
)
from .normalize import NormalizeError, normalize_and_render

logger = logging.getLogger(__name__)

MAX_INPUT_BYTES = 100_000_000
MAX_REQUEST_BYTES = 100_000_000
MAX_RESPONSE_BYTES = 1_000_000
READ_CHUNK_BYTES = 1024 * 1024
MAX_CONCURRENT_EXTRACTIONS = 1

_extraction_loop: asyncio.AbstractEventLoop | None = None
_extraction_semaphore: asyncio.Semaphore | None = None


@dataclass(frozen=True)
class ServiceError(Exception):
    code: str
    message: str
    transient: bool
    status_code: int


def _error_response(
    status_code: int,
    code: str,
    message: str,
    transient: bool,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "code": code,
            "message": message,
            "transient": transient,
        },
    )


class ExtractRequestGuard:
    def __init__(self, app: ASGIApp, expected_token: str) -> None:
        self.app = app
        self.expected_token = expected_token.encode()

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != "/v1/extract"
        ):
            await self.app(scope, receive, send)
            return

        headers = {
            name.lower(): value
            for name, value in scope.get("headers", [])
        }
        supplied = headers.get(b"x-recat-extractor-token", b"")
        if not hmac.compare_digest(supplied, self.expected_token):
            await JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized"},
            )(scope, receive, send)
            return

        length = headers.get(b"content-length")
        if length is not None:
            try:
                declared = int(length)
            except ValueError:
                declared = MAX_REQUEST_BYTES + 1
            if declared < 0 or declared > MAX_REQUEST_BYTES:
                await _error_response(
                    413,
                    "RECEIPT_REQUEST_TOO_LARGE",
                    "Receipt extraction request exceeds the input limit.",
                    False,
                )(scope, receive, send)
                return

        async with _limiter():
            with tempfile.SpooledTemporaryFile(
                max_size=READ_CHUNK_BYTES,
                mode="w+b",
            ) as buffered:
                received = 0
                while True:
                    message = await receive()
                    if message["type"] != "http.request":
                        return
                    body = message.get("body", b"")
                    received += len(body)
                    if received > MAX_REQUEST_BYTES:
                        await _error_response(
                            413,
                            "RECEIPT_REQUEST_TOO_LARGE",
                            "Receipt extraction request exceeds the input limit.",
                            False,
                        )(scope, receive, send)
                        return
                    buffered.write(body)
                    if not message.get("more_body", False):
                        break

                buffered.seek(0)

                async def replay_receive() -> Message:
                    body = buffered.read(READ_CHUNK_BYTES)
                    return {
                        "type": "http.request",
                        "body": body,
                        "more_body": bool(body),
                    }

                await self.app(scope, replay_receive, send)


def _limiter() -> asyncio.Semaphore:
    global _extraction_loop, _extraction_semaphore
    loop = asyncio.get_running_loop()
    if _extraction_loop is not loop or _extraction_semaphore is None:
        _extraction_loop = loop
        _extraction_semaphore = asyncio.Semaphore(MAX_CONCURRENT_EXTRACTIONS)
    return _extraction_semaphore


def _normalize_service_error(error: NormalizeError) -> ServiceError:
    message = str(error)
    if "page limit" in message:
        return ServiceError("RECEIPT_PAGE_LIMIT", message, False, 422)
    if "Unsupported" in message:
        return ServiceError(
            "RECEIPT_TYPE_UNSUPPORTED",
            "Unsupported receipt content type.",
            False,
            415,
        )
    if "rendered payload" in message:
        return ServiceError(
            "RECEIPT_RENDER_TOO_LARGE",
            "Document exceeds the rendered payload limit.",
            False,
            422,
        )
    if "pixel limit" in message:
        return ServiceError(
            "RECEIPT_IMAGE_TOO_LARGE",
            "Receipt image exceeds the source pixel limit.",
            False,
            422,
        )
    if "empty" in message:
        return ServiceError(
            "RECEIPT_INPUT_EMPTY",
            "Receipt file is empty.",
            False,
            422,
        )
    return ServiceError(
        "RECEIPT_INVALID_FILE",
        "Receipt file could not be normalized.",
        False,
        422,
    )


def _service_error(error: Exception) -> ServiceError:
    if isinstance(error, ServiceError):
        return error
    if isinstance(error, NormalizeError):
        return _normalize_service_error(error)
    if isinstance(error, TruncatedResponseError):
        return ServiceError(
            "RECEIPT_PROVIDER_TRUNCATED",
            "Provider response was truncated.",
            False,
            422,
        )
    if isinstance(error, ContentFilteredError):
        return ServiceError(
            "RECEIPT_CONTENT_FILTERED",
            "Provider filtered the receipt response.",
            False,
            422,
        )
    if isinstance(
        error,
        (
            litellm.ContentPolicyViolationError,
            BlockedPiiEntityError,
            GuardrailRaisedException,
        ),
    ):
        return ServiceError(
            "RECEIPT_CONTENT_FILTERED",
            "Provider filtered the receipt response.",
            False,
            422,
        )
    if isinstance(error, litellm.ContextWindowExceededError):
        return ServiceError(
            "RECEIPT_PROVIDER_CONTEXT_LIMIT",
            "Receipt exceeds the provider context limit.",
            False,
            422,
        )
    if isinstance(error, ParseFailure):
        return ServiceError(
            "RECEIPT_PARSE_FAILED",
            "Provider response could not be parsed.",
            True,
            502,
        )
    if isinstance(error, ProviderResponseError):
        return ServiceError(
            "RECEIPT_PROVIDER_RESPONSE_INVALID",
            "Provider returned an invalid response.",
            True,
            502,
        )
    if isinstance(
        error,
        (
            litellm.AuthenticationError,
            litellm.PermissionDeniedError,
        ),
    ):
        return ServiceError(
            "RECEIPT_PROVIDER_AUTH",
            "Provider authentication failed.",
            False,
            502,
        )
    if isinstance(error, BudgetExceededError):
        return ServiceError(
            "RECEIPT_PROVIDER_BUDGET",
            "Provider budget was exceeded.",
            False,
            502,
        )
    if isinstance(
        error,
        (
            litellm.BadRequestError,
            litellm.NotFoundError,
            litellm.UnprocessableEntityError,
        ),
    ):
        return ServiceError(
            "RECEIPT_PROVIDER_CONFIG",
            "Provider configuration is invalid.",
            False,
            502,
        )
    if isinstance(error, litellm.RateLimitError):
        return ServiceError(
            "RECEIPT_PROVIDER_RATE_LIMIT",
            "Provider rate limit was reached.",
            True,
            503,
        )
    if isinstance(
        error,
        (
            litellm.Timeout,
            litellm.APIConnectionError,
            litellm.ServiceUnavailableError,
        ),
    ):
        return ServiceError(
            "RECEIPT_PROVIDER_UNAVAILABLE",
            "Provider is temporarily unavailable.",
            True,
            503,
        )
    return ServiceError(
        "RECEIPT_PROVIDER_FAILED",
        "Receipt extraction failed.",
        True,
        502,
    )


async def read_bounded(upload: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while chunk := await upload.read(READ_CHUNK_BYTES):
        total += len(chunk)
        if total > MAX_INPUT_BYTES:
            raise ServiceError(
                "RECEIPT_INPUT_TOO_LARGE",
                "Receipt file exceeds the input limit.",
                False,
                413,
            )
        chunks.append(chunk)
    if total == 0:
        raise ServiceError(
            "RECEIPT_INPUT_EMPTY",
            "Receipt file is empty.",
            False,
            422,
        )
    return b"".join(chunks)


async def process_upload(
    request: ExtractionRequest,
    upload: UploadFile,
) -> ExtractionResponse:
    content = await read_bounded(upload)
    rendered = await asyncio.to_thread(
        normalize_and_render,
        content,
        upload.content_type or "",
        request.max_pages,
    )
    return await asyncio.to_thread(
        extract_document,
        rendered.pages,
        request,
    )


async def unavailable_process(
    _request: ExtractionRequest,
    _file: UploadFile,
) -> Any:
    raise HTTPException(status_code=503, detail="Extractor is not initialized")


def create_app(
    service_token: str | None = None,
    process: Callable[[ExtractionRequest, UploadFile], Awaitable[Any]] | None = None,
) -> FastAPI:
    expected = (
        service_token
        if service_token is not None
        else os.environ.get("RECEIPT_EXTRACTOR_TOKEN")
    )
    if not expected:
        raise RuntimeError("RECEIPT_EXTRACTOR_TOKEN is required.")
    processor = process or unavailable_process
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(ExtractRequestGuard, expected_token=expected)

    @app.exception_handler(ServiceError)
    async def service_error_handler(
        _request: Request,
        error: ServiceError,
    ) -> JSONResponse:
        return _error_response(
            error.status_code,
            error.code,
            error.message,
            error.transient,
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        _request: Request,
        _error: RequestValidationError,
    ) -> JSONResponse:
        return _error_response(
            422,
            "RECEIPT_REQUEST_INVALID",
            "Extraction request is invalid.",
            False,
        )

    @app.get("/healthz")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/v1/extract")
    async def extract(
        request: str = Form(..., max_length=100_000),
        file: UploadFile = File(...),
    ) -> Any:
        try:
            parsed = ExtractionRequest.model_validate(json.loads(request))
        except (json.JSONDecodeError, ValidationError, TypeError, ValueError):
            raise ServiceError(
                "RECEIPT_REQUEST_INVALID",
                "Extraction request is invalid.",
                False,
                422,
            ) from None
        try:
            result = await processor(parsed, file)
            if isinstance(result, ExtractionResponse):
                payload = result.model_dump_json()
            else:
                payload = json.dumps(
                    result,
                    allow_nan=False,
                    separators=(",", ":"),
                )
            if len(payload.encode("utf-8")) > MAX_RESPONSE_BYTES:
                raise ServiceError(
                    "RECEIPT_RESPONSE_TOO_LARGE",
                    "Extraction response exceeds the output limit.",
                    False,
                    502,
                )
            return Response(content=payload, media_type="application/json")
        except HTTPException:
            raise
        except Exception as error:
            service_error = _service_error(error)
            logger.warning(
                "extract request failed request_id=%s code=%s transient=%s",
                parsed.request_id,
                service_error.code,
                service_error.transient,
            )
            raise service_error from None

    return app


app = create_app(process=process_upload)
