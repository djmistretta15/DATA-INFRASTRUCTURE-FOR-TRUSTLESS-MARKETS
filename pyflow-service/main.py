"""
PyFlow Service API
Exposes Prefect workflows as HTTP endpoints for n8n integration.
"""
import asyncio
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from flows.arbitrage_bot import arbitrage_bot_flow
from flows.pricing_optimizer import pricing_optimizer_flow


app = FastAPI(
    title="GPU PyFlow Service",
    description="Prefect workflows for GPU rental automation",
    version="0.1.0"
)


# Request models
class ArbitrageRequest(BaseModel):
    gpu_types: Optional[List[str]] = Field(
        default=["H100", "A100"],
        description="GPU types to monitor"
    )
    min_margin_pct: float = Field(
        default=20.0,
        ge=5.0,
        le=50.0,
        description="Minimum margin % to trigger trade"
    )
    execute_trades: bool = Field(
        default=False,
        description="Actually execute trades vs. monitoring"
    )
    notification_webhook: Optional[str] = Field(
        default=None,
        description="Webhook URL for notifications (n8n or Discord)"
    )


class PricingOptimizationRequest(BaseModel):
    redis_url: str = Field(
        default="redis://redis:6379",
        description="Redis connection URL"
    )


# Response models
class FlowResponse(BaseModel):
    flow_run_id: str
    status: str
    started_at: str
    message: str


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "pyflow",
        "timestamp": datetime.utcnow().isoformat(),
        "version": "0.1.0"
    }


@app.post("/flows/arbitrage", response_model=FlowResponse)
async def trigger_arbitrage_flow(
    request: ArbitrageRequest,
    background_tasks: BackgroundTasks
):
    """
    Trigger the arbitrage bot flow.

    This can be called:
    - Manually via API
    - By n8n on a schedule
    - By n8n when triggered by an event
    """
    flow_run_id = f"arb_{datetime.utcnow().timestamp()}"

    # Run flow in background
    background_tasks.add_task(
        run_arbitrage_flow,
        request.gpu_types,
        request.min_margin_pct,
        request.execute_trades,
        request.notification_webhook
    )

    return FlowResponse(
        flow_run_id=flow_run_id,
        status="started",
        started_at=datetime.utcnow().isoformat(),
        message=f"Arbitrage bot flow started for {len(request.gpu_types)} GPU types"
    )


@app.post("/flows/arbitrage/sync")
async def trigger_arbitrage_flow_sync(request: ArbitrageRequest):
    """
    Trigger arbitrage flow and wait for completion.
    Use this when you need the result immediately.
    """
    result = await arbitrage_bot_flow(
        gpu_types=request.gpu_types,
        min_margin_pct=request.min_margin_pct,
        execute_trades=request.execute_trades,
        notification_webhook=request.notification_webhook
    )

    return result


@app.post("/flows/pricing-optimizer", response_model=FlowResponse)
async def trigger_pricing_optimizer(
    request: PricingOptimizationRequest,
    background_tasks: BackgroundTasks
):
    """
    Trigger the pricing optimizer flow.

    Recommended: Run every 15-30 minutes via n8n cron schedule.
    """
    flow_run_id = f"pricing_{datetime.utcnow().timestamp()}"

    background_tasks.add_task(
        run_pricing_optimizer,
        request.redis_url
    )

    return FlowResponse(
        flow_run_id=flow_run_id,
        status="started",
        started_at=datetime.utcnow().isoformat(),
        message="Pricing optimizer flow started"
    )


@app.post("/flows/pricing-optimizer/sync")
async def trigger_pricing_optimizer_sync(request: PricingOptimizationRequest):
    """Trigger pricing optimizer and wait for completion."""
    result = await pricing_optimizer_flow(redis_url=request.redis_url)
    return result


# Background task runners
async def run_arbitrage_flow(
    gpu_types: List[str],
    min_margin_pct: float,
    execute_trades: bool,
    notification_webhook: Optional[str]
):
    """Run arbitrage flow in background."""
    try:
        result = await arbitrage_bot_flow(
            gpu_types=gpu_types,
            min_margin_pct=min_margin_pct,
            execute_trades=execute_trades,
            notification_webhook=notification_webhook
        )
        print(f"Arbitrage flow completed: {result}")
    except Exception as e:
        print(f"Arbitrage flow error: {e}")


async def run_pricing_optimizer(redis_url: str):
    """Run pricing optimizer in background."""
    try:
        result = await pricing_optimizer_flow(redis_url=redis_url)
        print(f"Pricing optimizer completed: {result}")
    except Exception as e:
        print(f"Pricing optimizer error: {e}")


@app.get("/")
async def root():
    """Root endpoint with API information."""
    return {
        "service": "GPU PyFlow Service",
        "version": "0.1.0",
        "endpoints": {
            "health": "/health",
            "arbitrage_bot": "/flows/arbitrage",
            "arbitrage_bot_sync": "/flows/arbitrage/sync",
            "pricing_optimizer": "/flows/pricing-optimizer",
            "pricing_optimizer_sync": "/flows/pricing-optimizer/sync",
            "docs": "/docs"
        },
        "integration": {
            "n8n_webhook": "Call these endpoints from n8n HTTP Request nodes",
            "schedule": "Use n8n cron triggers for periodic execution"
        }
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
