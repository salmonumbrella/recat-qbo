FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp
RUN useradd --create-home --uid 10001 extractor
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.8.3 /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./

FROM base AS test
RUN uv sync --frozen
COPY recat_receipt_extractor ./recat_receipt_extractor
COPY tests ./tests
USER extractor
CMD ["/app/.venv/bin/pytest", "-q", "-p", "no:cacheprovider"]

FROM base AS runtime
RUN uv sync --frozen --no-dev
COPY recat_receipt_extractor ./recat_receipt_extractor
USER extractor
EXPOSE 8485
CMD ["/app/.venv/bin/uvicorn", \
     "recat_receipt_extractor.app:app", "--host", "0.0.0.0", "--port", "8485"]
