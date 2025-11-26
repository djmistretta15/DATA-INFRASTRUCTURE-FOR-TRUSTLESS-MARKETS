"""
Salad.com GPU provider integration.
TODO: Integrate with real Salad API once we have credentials.
"""
import asyncio
from typing import Optional
import httpx

from app.core.models import GPUType, Region, ProviderQuote, ProviderName


class SaladProvider:
    """
    Salad.com integration.
    Real API docs: https://docs.salad.com/
    """

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self.base_url = "https://api.salad.com/v1"
        self.timeout = 10.0

    async def get_quote(
        self,
        gpu_type: GPUType,
        vram_gb: int,
        hours: float,
        region: Region
    ) -> ProviderQuote:
        """
        Get pricing quote from Salad.
        TODO: Replace mock data with real API call.
        """
        # Simulate API latency
        await asyncio.sleep(0.3)

        # TODO: Real implementation would be:
        # async with httpx.AsyncClient() as client:
        #     response = await client.post(
        #         f"{self.base_url}/instances/quote",
        #         headers={"Authorization": f"Bearer {self.api_key}"},
        #         json={
        #             "gpu_type": gpu_type.value,
        #             "memory_gb": vram_gb,
        #             "duration_hours": hours,
        #             "region": region.value
        #         },
        #         timeout=self.timeout
        #     )
        #     data = response.json()
        #     return self._parse_response(data)

        # MOCK DATA - Realistic structure
        mock_prices = {
            GPUType.H100: 2.49,
            GPUType.H200: 3.20,
            GPUType.A100: 1.89,
            GPUType.A100_80GB: 2.10,
            GPUType.L40S: 1.25,
            GPUType.RTX_4090: 0.79,
            GPUType.RTX_6000_ADA: 1.10,
        }

        available = gpu_type in mock_prices
        hourly_cost = mock_prices.get(gpu_type)

        return ProviderQuote(
            provider=ProviderName.SALAD,
            available=available,
            hourly_cost=hourly_cost,
            total_cost=hourly_cost * hours if hourly_cost else None,
            region=region if region != Region.ANY else Region.US_WEST,
            vram_gb=vram_gb,
            gpu_type=gpu_type,
            instance_id=f"salad-mock-{gpu_type.value.lower()}" if available else None,
            connect_instructions_type="ssh",
            estimated_provision_minutes=3,
            reason_unavailable="GPU type not supported by Salad" if not available else None,
            metadata={
                "mock": True,
                "provider_display_name": "Salad.com",
                "supports_spot": True
            }
        )
