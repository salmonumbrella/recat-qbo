from __future__ import annotations

from copy import deepcopy
import os
from typing import Any

os.environ.setdefault("RECEIPT_EXTRACTOR_TOKEN", "synthetic-test-token")


def valid_request(**overrides: Any) -> dict[str, Any]:
    request: dict[str, Any] = {
        "request_id": "1f6d26c2-7332-4eb0-b93d-18d3ea625a30",
        "model": "openai/gpt-4o-mini",
        "api_base": "https://openrouter.ai/api/v1",
        "api_key": "request-secret",
        "temperature": 0,
        "max_tokens": 8192,
        "parse_retries": 2,
        "reasoning_effort": "none",
        "max_pages": 20,
        "business": {
            "names": ["Synthetic"],
            "addresses": [],
            "tax_ids": [],
        },
        "categories": {"expense": [], "issued": []},
    }
    request.update(deepcopy(overrides))
    return request
