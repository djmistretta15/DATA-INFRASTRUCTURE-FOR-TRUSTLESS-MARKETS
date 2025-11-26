"""
Pricing Optimizer Flow
Analyzes market conditions and optimizes surge pricing parameters.
"""
from datetime import datetime, timedelta
from typing import Dict, List
import asyncio

from prefect import flow, task, get_run_logger
import httpx
import redis.asyncio as redis


@task
async def fetch_recent_demand_data(redis_url: str = "redis://redis:6379") -> Dict:
    """Fetch recent demand metrics from Redis."""
    logger = get_run_logger()

    try:
        r = redis.from_url(redis_url, decode_responses=True)

        # Get recent quote requests
        now = datetime.utcnow().timestamp()
        one_hour_ago = now - 3600

        # Count recent quotes
        recent_quotes = await r.zcount("recent_quotes", one_hour_ago, now)

        # Get popular GPU types
        gpu_counts = {}
        quote_keys = await r.keys("quote:*")

        for key in quote_keys[:100]:  # Sample last 100
            quote_data = await r.get(key)
            if quote_data:
                # Parse GPU type from quote
                # For now, just count
                pass

        await r.close()

        return {
            "recent_quotes_1h": recent_quotes,
            "total_cached_quotes": len(quote_keys),
            "timestamp": datetime.utcnow().isoformat()
        }

    except Exception as e:
        logger.error(f"Error fetching demand data: {e}")
        return {"recent_quotes_1h": 0, "error": str(e)}


@task
def calculate_optimal_margins(
    demand_data: Dict,
    current_margins: Dict = None
) -> Dict:
    """
    Calculate optimal margin percentages based on demand.

    Strategy:
    - High demand (>100 quotes/hr) → increase margin by 5%
    - Medium demand (50-100) → base margin
    - Low demand (<50) → decrease margin by 3% to stay competitive
    """
    logger = get_run_logger()

    recent_demand = demand_data.get("recent_quotes_1h", 0)

    if current_margins is None:
        current_margins = {
            "base": 15.0,
            "peak_hours": 18.0,
            "off_peak": 12.0
        }

    # Demand multiplier
    if recent_demand > 100:
        demand_multiplier = 1.25  # +25%
        logger.info("🔥 High demand detected")
    elif recent_demand > 50:
        demand_multiplier = 1.0  # Base
        logger.info("📊 Normal demand")
    else:
        demand_multiplier = 0.85  # -15%
        logger.info("📉 Low demand - lowering margins")

    optimal_margins = {
        "base": round(current_margins["base"] * demand_multiplier, 2),
        "peak_hours": round(current_margins["peak_hours"] * demand_multiplier, 2),
        "off_peak": round(current_margins["off_peak"] * demand_multiplier, 2),
        "demand_level": "high" if recent_demand > 100 else "normal" if recent_demand > 50 else "low",
        "recent_demand": recent_demand,
        "calculated_at": datetime.utcnow().isoformat()
    }

    # Floor and ceiling
    for key in ["base", "peak_hours", "off_peak"]:
        optimal_margins[key] = max(8.0, min(optimal_margins[key], 35.0))

    logger.info(f"Optimal margins: {optimal_margins}")

    return optimal_margins


@task
async def update_pricing_config(optimal_margins: Dict) -> bool:
    """Update the price engine with new margin settings."""
    logger = get_run_logger()

    # TODO: Call price engine API to update margins
    # For now, just log
    logger.info(f"Would update pricing config to: {optimal_margins}")

    return True


@flow(name="Pricing Optimizer", log_prints=True)
async def pricing_optimizer_flow(redis_url: str = "redis://redis:6379"):
    """
    Analyze demand and optimize pricing margins.

    This flow should run every 15-30 minutes to adjust pricing
    based on real-time demand.
    """
    logger = get_run_logger()
    logger.info("🎯 Starting pricing optimization")

    # Fetch demand data
    demand_data = await fetch_recent_demand_data(redis_url)

    # Calculate optimal margins
    optimal_margins = calculate_optimal_margins(demand_data)

    # Update pricing
    success = await update_pricing_config(optimal_margins)

    result = {
        "success": success,
        "demand_data": demand_data,
        "optimal_margins": optimal_margins,
        "optimized_at": datetime.utcnow().isoformat()
    }

    logger.info(f"✨ Pricing optimization complete: {result}")

    return result


if __name__ == "__main__":
    result = asyncio.run(pricing_optimizer_flow())
    print(result)
