"""
Hyperstack GPU provider integration.
TODO: Integrate with real Hyperstack API once we have credentials.
"""
import asyncio
from typing import Optional

from app.core.models import GPUType, Region, ProviderQuote, ProviderName


class HyperstackProvider:
    """
    Hyperstack integration.
    """

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self.base_url = "https://api.hyperstack.cloud/v1"
        self.timeout = 10.0

    async def get_quote(
        self,
        gpu_type: GPUType,
        vram_gb: int,
        hours: float,
        region: Region
    ) -> ProviderQuote:
        """TODO: Replace with real API call."""
        await asyncio.sleep(0.35)

        mock_prices = {
            GPUType.H100: 2.60,
            GPUType.H200: 3.40,
            GPUType.A100: 1.95,
            GPUType.A100_80GB: 2.18,
            GPUType.L40S: 1.30,
        }

        available = gpu_type in mock_prices
        hourly_cost = mock_prices.get(gpu_type)

        return ProviderQuote(
            provider=ProviderName.HYPERSTACK,
            available=available,
            hourly_cost=hourly_cost,
            total_cost=hourly_cost * hours if hourly_cost else None,
            region=region if region != Region.ANY else Region.EU_WEST,
            vram_gb=vram_gb,
            gpu_type=gpu_type,
            instance_id=f"hyperstack-mock-{gpu_type.value.lower()}" if available else None,
            connect_instructions_type="ssh",
            estimated_provision_minutes=4,
            reason_unavailable="Not in Hyperstack catalog" if not available else None,
            metadata={"mock": True, "provider_display_name": "Hyperstack"}
        )
