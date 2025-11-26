"""
GPU Price Engine API
Aggregates pricing from multiple GPU providers and returns best quote with margin applied.
"""
import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

import redis.asyncio as redis
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.core.models import (
    BestQuote,
    GPUType,
    HealthCheck,
    ProviderQuote,
    QuoteRequest,
    QuoteResponse,
)
from app.core.surge import SurgeEngine
from app.providers.salad import SaladProvider
from app.providers.vast import VastProvider
from app.providers.hyperstack import HyperstackProvider
from app.providers.runpod import RunPodProvider
from app.providers.lambda_labs import LambdaProvider


# Global state
redis_client: Optional[redis.Redis] = None
surge_engine: Optional[SurgeEngine] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup resources."""
    global redis_client, surge_engine

    # Startup
    redis_host = os.getenv("REDIS_HOST", "localhost")
    redis_port = int(os.getenv("REDIS_PORT", "6379"))
    redis_db = int(os.getenv("REDIS_DB", "0"))

    redis_client = redis.Redis(
        host=redis_host,
        port=redis_port,
        db=redis_db,
        decode_responses=True
    )

    base_margin = float(os.getenv("BASE_MARGIN_PCT", "15.0"))
    surge_engine = SurgeEngine(redis_client, base_margin_pct=base_margin)

    print(f"✓ Connected to Redis at {redis_host}:{redis_port}")
    print(f"✓ Base margin: {base_margin}%")

    yield

    # Shutdown
    if redis_client:
        await redis_client.close()
        print("✓ Redis connection closed")


app = FastAPI(
    title="GPU Price Engine",
    description="Multi-provider GPU rental price aggregation and arbitrage API",
    version="0.1.0",
    lifespan=lifespan
)

# CORS - adjust origins for production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: Lock down in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Initialize providers
providers = []


def get_providers():
    """Lazy-load providers with API keys from environment."""
    global providers
    if not providers:
        providers = [
            SaladProvider(api_key=os.getenv("SALAD_API_KEY")),
            VastProvider(api_key=os.getenv("VAST_API_KEY")),
            HyperstackProvider(api_key=os.getenv("HYPERSTACK_API_KEY")),
            RunPodProvider(api_key=os.getenv("RUNPOD_API_KEY")),
            LambdaProvider(api_key=os.getenv("LAMBDA_API_KEY")),
        ]
    return providers


@app.get("/health", response_model=HealthCheck)
async def health_check():
    """Health check endpoint for monitoring."""
    redis_ok = False
    try:
        if redis_client:
            await redis_client.ping()
            redis_ok = True
    except Exception:
        pass

    return HealthCheck(
        status="healthy" if redis_ok else "degraded",
        redis_connected=redis_ok,
        version="0.1.0"
    )


@app.post("/quote", response_model=QuoteResponse)
async def get_quote(request: QuoteRequest):
    """
    Get best GPU pricing quote across all providers.

    This endpoint:
    1. Queries all providers concurrently
    2. Filters by availability and max_price constraint
    3. Applies dynamic margin based on surge pricing
    4. Returns best quote with full pricing breakdown
    """
    request_id = f"req_{uuid.uuid4().hex[:12]}"

    # Record request for surge tracking
    if surge_engine:
        await surge_engine.record_quote_request(request_id)

    # Query all providers concurrently
    all_providers = get_providers()
    tasks = [
        provider.get_quote(
            gpu_type=request.gpu_type,
            vram_gb=request.vram_gb,
            hours=request.hours,
            region=request.region
        )
        for provider in all_providers
    ]

    provider_quotes: list[ProviderQuote] = await asyncio.gather(*tasks, return_exceptions=False)

    # Filter to available quotes
    available_quotes = [q for q in provider_quotes if q.available and q.hourly_cost is not None]

    # Apply max_price filter if specified
    if request.max_price_per_hour:
        available_quotes = [
            q for q in available_quotes
            if q.hourly_cost <= request.max_price_per_hour
        ]

    if not available_quotes:
        return QuoteResponse(
            success=False,
            error="No providers available for the requested GPU configuration",
            all_provider_quotes=provider_quotes
        )

    # Sort by total cost (cheapest first)
    available_quotes.sort(key=lambda q: q.total_cost)

    # Select best quote
    best_provider_quote = available_quotes[0]

    # Check for upgrade opportunity
    # If a better GPU is available within 10% price, upgrade
    is_upgraded = False
    upgraded_from = None
    gpu_tier = {
        GPUType.RTX_4090: 1,
        GPUType.RTX_6000_ADA: 2,
        GPUType.L40S: 3,
        GPUType.A100: 4,
        GPUType.A100_80GB: 5,
        GPUType.H100: 6,
        GPUType.H200: 7,
        GPUType.B200: 8,
    }

    current_tier = gpu_tier.get(best_provider_quote.gpu_type, 0)
    for quote in available_quotes:
        other_tier = gpu_tier.get(quote.gpu_type, 0)
        if other_tier > current_tier:
            price_diff_pct = (
                (quote.total_cost - best_provider_quote.total_cost)
                / best_provider_quote.total_cost * 100
            )
            if price_diff_pct <= 10:  # Within 10%
                upgraded_from = best_provider_quote.gpu_type
                best_provider_quote = quote
                is_upgraded = True
                break

    # Calculate margin
    surge_enabled = os.getenv("SURGE_ENABLED", "false").lower() == "true"
    if surge_enabled and surge_engine:
        margin_pct = await surge_engine.calculate_margin(
            priority=request.priority,
            gpu_type=best_provider_quote.gpu_type.value
        )
    else:
        margin_pct = float(os.getenv("BASE_MARGIN_PCT", "15.0"))

    # Apply margin
    base_hourly = best_provider_quote.hourly_cost
    margin_amount = base_hourly * (margin_pct / 100)
    final_hourly = base_hourly + margin_amount
    estimated_total = final_hourly * request.hours

    # Build response
    quote = BestQuote(
        request_id=request_id,
        provider=best_provider_quote.provider,
        gpu_type=best_provider_quote.gpu_type,
        vram_gb=best_provider_quote.vram_gb,
        region=best_provider_quote.region,
        base_hourly_cost=round(base_hourly, 2),
        margin_pct=round(margin_pct, 2),
        margin_amount=round(margin_amount, 2),
        final_hourly_cost=round(final_hourly, 2),
        hours=request.hours,
        estimated_total=round(estimated_total, 2),
        connect_instructions_type=best_provider_quote.connect_instructions_type,
        estimated_provision_minutes=best_provider_quote.estimated_provision_minutes,
        quoted_at=datetime.now(timezone.utc),
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
        is_upgraded=is_upgraded,
        upgraded_from=upgraded_from
    )

    # Cache quote in Redis
    if redis_client:
        try:
            cache_ttl = int(os.getenv("CACHE_TTL_SECONDS", "900"))  # 15 minutes
            await redis_client.setex(
                f"quote:{request_id}",
                cache_ttl,
                quote.model_dump_json()
            )
        except Exception as e:
            print(f"Warning: Failed to cache quote: {e}")

    return QuoteResponse(
        success=True,
        quote=quote,
        all_provider_quotes=provider_quotes
    )


@app.get("/surge-status")
async def get_surge_status():
    """
    Get current surge pricing status.
    Useful for monitoring and debugging.
    """
    if not surge_engine:
        raise HTTPException(status_code=503, detail="Surge engine not initialized")

    return await surge_engine.get_surge_info()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
