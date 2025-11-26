"""
Vast.ai GPU provider integration.
TODO: Integrate with real Vast API once we have credentials.
"""
import asyncio
from typing import Optional

from app.core.models import GPUType, Region, ProviderQuote, ProviderName


class VastProvider:
    """
    Vast.ai integration.
    Real API docs: https://vast.ai/docs/
    """

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self.base_url = "https://console.vast.ai/api/v0"
        self.timeout = 10.0

    async def get_quote(
        self,
        gpu_type: GPUType,
        vram_gb: int,
        hours: float,
        region: Region
    ) -> ProviderQuote:
        """
        Get pricing quote from Vast.ai.
        TODO: Replace mock data with real API call.
        """
        await asyncio.sleep(0.4)

        # MOCK DATA - Vast typically has slightly higher prices but better availability
        mock_prices = {
            GPUType.H100: 2.75,
            GPUType.A100: 2.00,
            GPUType.A100_80GB: 2.25,
            GPUType.L40S: 1.40,
            GPUType.RTX_4090: 0.85,
            GPUType.RTX_6000_ADA: 1.20,
        }

        available = gpu_type in mock_prices
        hourly_cost = mock_prices.get(gpu_type)

        return ProviderQuote(
            provider=ProviderName.VAST,
            available=available,
            hourly_cost=hourly_cost,
            total_cost=hourly_cost * hours if hourly_cost else None,
            region=region if region != Region.ANY else Region.US_EAST,
            vram_gb=vram_gb,
            gpu_type=gpu_type,
            instance_id=f"vast-mock-{gpu_type.value.lower()}" if available else None,
            connect_instructions_type="ssh",
            estimated_provision_minutes=2,
            reason_unavailable="GPU type not available" if not available else None,
            metadata={
                "mock": True,
                "provider_display_name": "Vast.ai",
                "supports_interruptible": True
            }
        )
