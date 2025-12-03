# Multi-stage Dockerfile for ML Anomaly Detection Service
# Python-based with optimized scientific computing libraries

# Stage 1: Builder with compilation tools
FROM python:3.11-slim AS builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    gfortran \
    libopenblas-dev \
    liblapack-dev \
    pkg-config \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for caching
COPY ml/requirements.txt .

# Create virtual environment and install dependencies
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    pip install --no-cache-dir -r requirements.txt

# Stage 2: Runtime
FROM python:3.11-slim AS runtime

WORKDIR /app

# Create non-root user
RUN groupadd -g 1001 mluser && \
    useradd -u 1001 -g mluser -s /bin/bash -m mluser

# Install runtime dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopenblas0 \
    libgomp1 \
    curl \
    ca-certificates \
    tzdata \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy ML application code
COPY --chown=mluser:mluser ml/ ./ml/
COPY --chown=mluser:mluser scripts/ ./scripts/

# Create directories
RUN mkdir -p /app/models /app/data /app/logs /app/cache && \
    chown -R mluser:mluser /app

# Build arguments
ARG VERSION=unknown
ARG BUILD_DATE=unknown
ARG GIT_COMMIT=unknown

LABEL org.opencontainers.image.title="ML Anomaly Detector" \
      org.opencontainers.image.description="Machine learning service for oracle anomaly detection" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"

# Environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=UTC \
    VERSION=${VERSION} \
    MODEL_PATH=/app/models \
    CACHE_DIR=/app/cache \
    LOG_LEVEL=INFO \
    PORT=8001 \
    NUM_WORKERS=4

# Health check
HEALTHCHECK --interval=30s --timeout=15s --start-period=90s --retries=3 \
    CMD curl -sf http://localhost:${PORT}/v1/health || exit 1

USER mluser

EXPOSE 8001

ENTRYPOINT ["dumb-init", "--"]

CMD ["python", "-m", "uvicorn", "ml.serving.model_server:app", \
     "--host", "0.0.0.0", "--port", "8001", "--workers", "4", "--log-level", "info"]
