# Adapted from LevMuchnik/Receiptory at
# 5afac9f01f29a474e1609d364b0ac8584caace13.
# Licensed under AGPL-3.0-only.

from decimal import Decimal

import litellm


def estimate_cost(model: str, tokens_in: int, tokens_out: int) -> Decimal:
    try:
        prompt, completion = litellm.cost_per_token(
            model=model,
            prompt_tokens=tokens_in,
            completion_tokens=tokens_out,
        )
        if prompt is not None and completion is not None:
            return Decimal(str(prompt)) + Decimal(str(completion))
    except Exception:
        pass
    return (
        Decimal(tokens_in) * Decimal("1")
        + Decimal(tokens_out) * Decimal("3")
    ) / Decimal("1000000")
