"""
RunPod GPU provider integration.
TODO: Integrate with real RunPod API once we have credentials.
"""
import asyncio
from typing import Optional

from app.core.models import GPUType, Region, ProviderQuote, ProviderName


class RunPodProvider:
    """RunPod integration."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self.base_url = "https://api.runpod.io/v2"
        self.timeout = 10.0

    async def get_quote(
        self,
        gpu_type: GPUType,
        vram_gb: int,
        hours: float,
        region: Region
    ) -> ProviderQuote:
        """TODO: Replace with real API call."""
        await asyncio.sleep(0.25)

        mock_prices = {
            GPUType.H100: 2.55,
            GPUType.A100: 1.85,
            GPUType.A100_80GB: 2.05,
            GPUType.RTX_4090: 0.69,
            GPUType.RTX_6000_ADA: 1.05,
        }

        available = gpu_type in mock_prices
        hourly_cost = mock_prices.get(gpu_type)

        return ProviderQuote(
            provider=ProviderName.RUNPOD,
            available=available,
            hourly_cost=hourly_cost,
            total_cost=hourly_cost * hours if hourly_cost else None,
            region=region if region != Region.ANY else Region.US_WEST,
            vram_gb=vram_gb,
            gpu_type=gpu_type,
            instance_id=f"runpod-mock-{gpu_type.value.lower()}" if available else None,
            connect_instructions_type="jupyter",
            estimated_provision_minutes=2,
            reason_unavailable="RunPod unavailable" if not available else None,
            metadata={"mock": True, "provider_display_name": "RunPod"}
        )
