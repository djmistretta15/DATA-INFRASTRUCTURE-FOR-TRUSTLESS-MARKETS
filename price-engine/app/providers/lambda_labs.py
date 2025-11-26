"""
Lambda Labs GPU provider integration.
TODO: Integrate with real Lambda API once we have credentials.
"""
import asyncio
from typing import Optional

from app.core.models import GPUType, Region, ProviderQuote, ProviderName


class LambdaProvider:
    """Lambda Labs integration."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self.base_url = "https://cloud.lambdalabs.com/api/v1"
        self.timeout = 10.0

    async def get_quote(
        self,
        gpu_type: GPUType,
        vram_gb: int,
        hours: float,
        region: Region
    ) -> ProviderQuote:
        """TODO: Replace with real API call."""
        await asyncio.sleep(0.3)

        mock_prices = {
            GPUType.H100: 2.69,
            GPUType.A100: 1.99,
            GPUType.A100_80GB: 2.20,
        }

        available = gpu_type in mock_prices
        hourly_cost = mock_prices.get(gpu_type)

        return ProviderQuote(
            provider=ProviderName.LAMBDA,
            available=available,
            hourly_cost=hourly_cost,
            total_cost=hourly_cost * hours if hourly_cost else None,
            region=region if region != Region.ANY else Region.US_EAST,
            vram_gb=vram_gb,
            gpu_type=gpu_type,
            instance_id=f"lambda-mock-{gpu_type.value.lower()}" if available else None,
            connect_instructions_type="ssh",
            estimated_provision_minutes=5,
            reason_unavailable="Not available on Lambda" if not available else None,
            metadata={"mock": True, "provider_display_name": "Lambda Labs"}
        )
