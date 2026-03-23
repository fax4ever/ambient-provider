# SPDX-FileCopyrightText: Copyright (c) 2024-2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Multi-stage build for Python API using approved Ubuntu 24.04 base
FROM ubuntu:24.04 as builder

# Install system dependencies for building including Python 3.13
RUN apt-get update && apt-get install -y \
    software-properties-common \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y \
    python3.13 \
    python3.13-dev \
    python3.13-venv \
    python3-pip \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create and activate virtual environment with Python 3.13
RUN python3.13 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Set working directory
WORKDIR /app

# Copy requirements and source code for installation
COPY apps/api/pyproject.toml /app/
COPY apps/api/ambient_scribe /app/ambient_scribe/
RUN pip install --no-cache-dir --upgrade pip
RUN pip install --no-cache-dir -e .

# Production stage using approved Ubuntu 24.04 base
FROM ubuntu:24.04

# Install runtime dependencies including Python 3.13
RUN apt-get update && apt-get install -y \
    software-properties-common \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y \
    python3.13 \
    python3.13-venv \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Set working directory
WORKDIR /app

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application code
COPY apps/api /app

# Create necessary directories
RUN mkdir -p /app/uploads /app/logs /tmp/numba_cache && \
    chown -R appuser:appuser /app /tmp/numba_cache && \
    chmod -R a+w /app/uploads /app/logs /tmp/numba_cache

# Set environment variables to prevent librosa/numba caching issues
ENV NUMBA_CACHE_DIR=/tmp/numba_cache
ENV NUMBA_DISABLE_CACHING=1

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8000/api/health/', timeout=5)"

# Command to run the application
CMD ["uvicorn", "ambient_scribe.main:app", "--host", "0.0.0.0", "--port", "8000"]
