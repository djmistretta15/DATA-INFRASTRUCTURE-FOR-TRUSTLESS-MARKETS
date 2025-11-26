"""
Core data models for GPU pricing and quotes.
"""
from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator


class GPUType(str, Enum):
    """Supported GPU types."""
    H100 = "H100"
    H200 = "H200"
    A100 = "A100"
    A100_80GB = "A100-80GB"
    L40S = "L40S"
    RTX_4090 = "RTX-4090"
    RTX_6000_ADA = "RTX-6000-Ada"
    B200 = "B200"  # Future-proofing


class Region(str, Enum):
    """Geographic regions."""
    US_EAST = "us-east"
    US_WEST = "us-west"
    EU_WEST = "eu-west"
    EU_CENTRAL = "eu-central"
    ASIA_PACIFIC = "asia-pacific"
    ANY = "any"


class Priority(str, Enum):
    """Job priority levels."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


class ProviderName(str, Enum):
    """Known GPU providers."""
    SALAD = "salad"
    VAST = "vast"
    HYPERSTACK = "hyperstack"
    RUNPOD = "runpod"
    LAMBDA = "lambda"
    INTERNAL = "internal"  # For arbitrage bot's own inventory


class QuoteRequest(BaseModel):
    """Request for GPU pricing quote."""
    gpu_type: GPUType
    vram_gb: int = Field(ge=8, le=640, description="VRAM in GB")
    hours: float = Field(ge=0.1, le=720, description="Rental duration in hours")
    region: Region = Region.ANY
    max_price_per_hour: Optional[float] = Field(None, ge=0, description="Max acceptable price/hr")
    priority: Priority = Priority.NORMAL

    @field_validator('vram_gb')
    @classmethod
    def validate_vram(cls, v: int, info) -> int:
        """Ensure VRAM is reasonable for the GPU type."""
        # Basic validation - can be expanded
        if v < 8:
            raise ValueError("Minimum 8GB VRAM required")
        return v


class ProviderQuote(BaseModel):
    """Individual provider's quote response."""
    provider: ProviderName
    available: bool
    hourly_cost: Optional[float] = Field(None, description="Provider's raw cost per hour")
    total_cost: Optional[float] = Field(None, description="Total cost for requested hours")
    region: Region
    vram_gb: int
    gpu_type: GPUType
    instance_id: Optional[str] = None
    connect_instructions_type: str = Field(
        default="ssh",
        description="ssh, jupyter, api, etc."
    )
    estimated_provision_minutes: int = Field(default=5, ge=1, le=60)
    metadata: dict = Field(default_factory=dict, description="Provider-specific extras")

    # Availability notes
    reason_unavailable: Optional[str] = None
    next_available_eta: Optional[datetime] = None


class BestQuote(BaseModel):
    """Final quote returned to user/n8n."""
    request_id: str = Field(description="Unique ID for this quote request")
    provider: ProviderName
    gpu_type: GPUType
    vram_gb: int
    region: Region

    # Pricing breakdown
    base_hourly_cost: float = Field(description="Provider's raw cost/hr")
    margin_pct: float = Field(description="Our margin percentage applied")
    margin_amount: float = Field(description="Dollar margin per hour")
    final_hourly_cost: float = Field(description="What customer pays per hour")

    hours: float
    estimated_total: float = Field(description="Total cost for requested hours")

    # Metadata
    connect_instructions_type: str
    estimated_provision_minutes: int
    quoted_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime = Field(description="Quote validity window")

    # Upsell flag
    is_upgraded: bool = Field(
        default=False,
        description="True if we upgraded to better GPU at similar price"
    )
    upgraded_from: Optional[GPUType] = None

    class Config:
        json_schema_extra = {
            "example": {
                "request_id": "req_abc123",
                "provider": "salad",
                "gpu_type": "H100",
                "vram_gb": 80,
                "region": "us-west",
                "base_hourly_cost": 2.49,
                "margin_pct": 15.0,
                "margin_amount": 0.37,
                "final_hourly_cost": 2.86,
                "hours": 4.0,
                "estimated_total": 11.44,
                "connect_instructions_type": "ssh",
                "estimated_provision_minutes": 3,
                "is_upgraded": False
            }
        }


class QuoteResponse(BaseModel):
    """Response from /quote endpoint."""
    success: bool
    quote: Optional[BestQuote] = None
    error: Optional[str] = None
    all_provider_quotes: list[ProviderQuote] = Field(
        default_factory=list,
        description="All provider responses for debugging"
    )


class HealthCheck(BaseModel):
    """Health check response."""
    status: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    redis_connected: bool
    version: str = "0.1.0"
