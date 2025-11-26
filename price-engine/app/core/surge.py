"""
Dynamic surge pricing engine.
Adjusts margin based on demand, time-of-day, and provider utilization.
"""
from datetime import datetime, timezone
from typing import Optional
import redis.asyncio as redis

from .models import Priority


class SurgeEngine:
    """
    Calculates dynamic margin adjustments based on:
    - Time of day (peak hours = higher margin)
    - Global demand (tracked in Redis counters)
    - Provider utilization
    - Request priority
    """

    def __init__(self, redis_client: redis.Redis, base_margin_pct: float = 15.0):
        self.redis = redis_client
        self.base_margin = base_margin_pct

    async def calculate_margin(
        self,
        priority: Priority,
        gpu_type: str,
        current_demand: Optional[int] = None
    ) -> float:
        """
        Calculate adjusted margin percentage.

        Returns:
            float: Margin percentage to apply (e.g., 18.5 for 18.5%)
        """
        margin = self.base_margin

        # Time-of-day multiplier
        hour = datetime.now(timezone.utc).hour
        if 14 <= hour <= 22:  # Peak US hours (9am-5pm EST roughly)
            margin += 3.0
        elif 0 <= hour <= 6:  # Off-peak
            margin -= 2.0

        # Demand-based surge
        if current_demand is None:
            current_demand = await self._get_current_demand()

        if current_demand > 50:  # High demand
            margin += 5.0
        elif current_demand > 20:  # Medium demand
            margin += 2.0

        # Priority bump
        if priority == Priority.URGENT:
            margin += 8.0
        elif priority == Priority.HIGH:
            margin += 4.0
        elif priority == Priority.LOW:
            margin -= 3.0

        # GPU type premium (some GPUs are hotter commodities)
        if gpu_type in ["H100", "H200", "B200"]:
            margin += 2.0

        # Floor and ceiling
        margin = max(5.0, min(margin, 40.0))

        return round(margin, 2)

    async def _get_current_demand(self) -> int:
        """
        Get current demand from Redis.
        We track active quote requests in a sorted set with TTL.
        """
        try:
            # Count recent quote requests (last 5 minutes)
            now = datetime.now(timezone.utc).timestamp()
            five_min_ago = now - 300
            count = await self.redis.zcount("recent_quotes", five_min_ago, now)
            return int(count)
        except Exception:
            # If Redis fails, return neutral demand
            return 10

    async def record_quote_request(self, request_id: str):
        """
        Record a quote request for demand tracking.
        Uses sorted set with timestamp as score for automatic TTL cleanup.
        """
        try:
            now = datetime.now(timezone.utc).timestamp()
            await self.redis.zadd("recent_quotes", {request_id: now})
            # Clean up old entries (older than 10 minutes)
            ten_min_ago = now - 600
            await self.redis.zremrangebyscore("recent_quotes", 0, ten_min_ago)
        except Exception:
            pass  # Non-critical

    async def get_surge_info(self) -> dict:
        """
        Get current surge pricing status for monitoring/debugging.
        """
        demand = await self._get_current_demand()
        hour = datetime.now(timezone.utc).hour
        base_margin = self.base_margin

        return {
            "base_margin_pct": base_margin,
            "current_demand": demand,
            "utc_hour": hour,
            "is_peak_hours": 14 <= hour <= 22,
            "estimated_surge_low": await self.calculate_margin(Priority.LOW, "RTX-4090"),
            "estimated_surge_high": await self.calculate_margin(Priority.URGENT, "H100")
        }
