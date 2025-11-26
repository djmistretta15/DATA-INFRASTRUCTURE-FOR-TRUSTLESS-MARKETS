"""
Arbitrage Bot Flow
Monitors GPU prices across providers and executes buy-low-sell-high strategies.
"""
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import asyncio

from prefect import flow, task, get_run_logger
from prefect.tasks import task_input_hash
import httpx


@task(cache_key_fn=task_input_hash, cache_expiration=timedelta(minutes=5))
async def fetch_all_provider_prices(gpu_type: str = "H100") -> List[Dict]:
    """Fetch current prices from all providers via price-engine."""
    logger = get_run_logger()
    logger.info(f"Fetching prices for {gpu_type}")

    price_engine_url = "http://price-engine:8000"

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{price_engine_url}/quote",
                json={
                    "gpu_type": gpu_type,
                    "vram_gb": 80,
                    "hours": 24,  # Look at 24-hour pricing
                    "region": "any",
                    "priority": "normal"
                },
                timeout=15.0
            )
            data = response.json()

            if data.get("success"):
                # Return all provider quotes
                return data.get("all_provider_quotes", [])
            else:
                logger.warning(f"No prices available: {data.get('error')}")
                return []

    except Exception as e:
        logger.error(f"Error fetching prices: {e}")
        return []


@task
def analyze_arbitrage_opportunities(
    provider_quotes: List[Dict],
    min_margin_pct: float = 20.0
) -> List[Dict]:
    """
    Analyze provider quotes to find arbitrage opportunities.

    Strategy: Buy from cheapest provider, resell at market rate with margin.
    """
    logger = get_run_logger()

    if not provider_quotes or len(provider_quotes) < 2:
        logger.info("Need at least 2 providers for arbitrage")
        return []

    # Filter available providers
    available = [q for q in provider_quotes if q.get("available")]

    if len(available) < 2:
        logger.info("Not enough available providers")
        return []

    # Sort by cost
    sorted_providers = sorted(available, key=lambda q: q.get("hourly_cost", 999))

    cheapest = sorted_providers[0]
    market_avg = sum(q["hourly_cost"] for q in sorted_providers) / len(sorted_providers)

    # Calculate potential margin
    buy_cost = cheapest["hourly_cost"]
    sell_price = market_avg * 0.95  # Sell slightly below average for competitiveness
    margin_pct = ((sell_price - buy_cost) / buy_cost) * 100

    opportunities = []

    if margin_pct >= min_margin_pct:
        opportunity = {
            "gpu_type": cheapest["gpu_type"],
            "buy_provider": cheapest["provider"],
            "buy_cost_per_hour": buy_cost,
            "sell_price_per_hour": sell_price,
            "margin_pct": round(margin_pct, 2),
            "estimated_profit_24h": round((sell_price - buy_cost) * 24, 2),
            "market_avg": round(market_avg, 2),
            "detected_at": datetime.utcnow().isoformat()
        }
        opportunities.append(opportunity)

        logger.info(
            f"🎯 Arbitrage opportunity found! "
            f"Buy from {cheapest['provider']} at ${buy_cost}/hr, "
            f"sell at ${sell_price}/hr ({margin_pct:.1f}% margin)"
        )
    else:
        logger.info(
            f"No arbitrage: margin only {margin_pct:.1f}% "
            f"(need {min_margin_pct}%)"
        )

    return opportunities


@task
async def execute_arbitrage_trade(opportunity: Dict) -> Dict:
    """
    Execute an arbitrage trade:
    1. Reserve GPU from cheap provider
    2. Add to our inventory pool
    3. Make available for resale
    """
    logger = get_run_logger()

    logger.info(f"Executing trade: {opportunity}")

    # TODO: Real implementation would:
    # 1. Call provider API to reserve instance
    # 2. Store in Redis/Supabase as "inventory"
    # 3. Mark as available for customer orders
    # 4. Track utilization and profit

    trade_result = {
        **opportunity,
        "status": "executed",
        "instance_id": f"arb_{datetime.utcnow().timestamp()}",
        "executed_at": datetime.utcnow().isoformat()
    }

    logger.info(f"✅ Trade executed: {trade_result['instance_id']}")

    return trade_result


@task
async def notify_arbitrage_opportunity(opportunity: Dict, webhook_url: Optional[str] = None):
    """Send notification about arbitrage opportunity to n8n or Discord."""
    logger = get_run_logger()

    if not webhook_url:
        logger.info("No webhook configured, skipping notification")
        return

    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                webhook_url,
                json={
                    "type": "arbitrage_opportunity",
                    "data": opportunity,
                    "timestamp": datetime.utcnow().isoformat()
                },
                timeout=10.0
            )
        logger.info("Notification sent successfully")
    except Exception as e:
        logger.error(f"Failed to send notification: {e}")


@flow(name="GPU Arbitrage Bot", log_prints=True)
async def arbitrage_bot_flow(
    gpu_types: List[str] = None,
    min_margin_pct: float = 20.0,
    execute_trades: bool = False,
    notification_webhook: Optional[str] = None
):
    """
    Main arbitrage bot flow.

    Args:
        gpu_types: List of GPU types to monitor (default: H100, A100)
        min_margin_pct: Minimum margin % to trigger trade (default: 20%)
        execute_trades: Actually execute trades vs. just monitor (default: False)
        notification_webhook: URL to send notifications (n8n or Discord)
    """
    logger = get_run_logger()

    if gpu_types is None:
        gpu_types = ["H100", "A100", "A100-80GB"]

    logger.info(f"🤖 Starting arbitrage bot for GPUs: {gpu_types}")
    logger.info(f"Min margin: {min_margin_pct}%, Execute: {execute_trades}")

    all_opportunities = []

    # Check each GPU type
    for gpu_type in gpu_types:
        logger.info(f"Analyzing {gpu_type}...")

        # Fetch prices
        provider_quotes = await fetch_all_provider_prices(gpu_type)

        # Find opportunities
        opportunities = analyze_arbitrage_opportunities(
            provider_quotes,
            min_margin_pct=min_margin_pct
        )

        # Process opportunities
        for opp in opportunities:
            all_opportunities.append(opp)

            # Send notification
            if notification_webhook:
                await notify_arbitrage_opportunity(opp, notification_webhook)

            # Execute trade if enabled
            if execute_trades:
                trade_result = await execute_arbitrage_trade(opp)
                logger.info(f"Trade result: {trade_result}")
            else:
                logger.info("📊 Monitoring mode - trade not executed")

    logger.info(
        f"✨ Arbitrage scan complete. "
        f"Found {len(all_opportunities)} opportunities"
    )

    return {
        "opportunities_found": len(all_opportunities),
        "opportunities": all_opportunities,
        "scanned_at": datetime.utcnow().isoformat()
    }


if __name__ == "__main__":
    # Run the flow locally for testing
    result = asyncio.run(
        arbitrage_bot_flow(
            gpu_types=["H100"],
            min_margin_pct=15.0,
            execute_trades=False
        )
    )
    print(result)
