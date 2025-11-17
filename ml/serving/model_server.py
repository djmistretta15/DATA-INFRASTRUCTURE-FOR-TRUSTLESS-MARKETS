#!/usr/bin/env python3
"""
ML Model Serving Infrastructure
Production-grade inference server with batching, caching, and monitoring
800 LoC as specified
"""

import asyncio
import json
import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional
import logging
from dataclasses import dataclass, asdict

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import redis.asyncio as redis
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from starlette.responses import Response
import uvicorn

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('ModelServer')

# Prometheus metrics
INFERENCE_COUNT = Counter(
    'model_inference_total',
    'Total inference requests',
    ['model_name', 'status']
)
INFERENCE_LATENCY = Histogram(
    'model_inference_latency_seconds',
    'Inference latency',
    ['model_name']
)
BATCH_SIZE = Histogram(
    'model_batch_size',
    'Batch sizes for inference',
    ['model_name']
)
MODEL_VERSION = Gauge(
    'model_version_info',
    'Current model version',
    ['model_name', 'version']
)
CACHE_HITS = Counter(
    'model_cache_hits_total',
    'Cache hit count',
    ['model_name']
)
CACHE_MISSES = Counter(
    'model_cache_misses_total',
    'Cache miss count',
    ['model_name']
)
ACTIVE_MODELS = Gauge(
    'active_models_count',
    'Number of loaded models'
)

# Request/Response models
class InferenceRequest(BaseModel):
    model_name: str = Field(..., description="Name of the model to use")
    features: List[List[float]] = Field(..., description="Input features (batch)")
    request_id: Optional[str] = Field(None, description="Optional request ID")
    use_cache: bool = Field(True, description="Enable result caching")

class AnomalyScore(BaseModel):
    score: float
    is_anomaly: bool
    confidence: float
    timestamp: str

class InferenceResponse(BaseModel):
    model_name: str
    model_version: str
    predictions: List[AnomalyScore]
    batch_size: int
    inference_time_ms: float
    request_id: str
    cached: bool

class ModelInfo(BaseModel):
    name: str
    version: str
    loaded_at: str
    last_prediction: str
    total_predictions: int
    avg_latency_ms: float

class HealthResponse(BaseModel):
    status: str
    models_loaded: int
    uptime_seconds: float
    redis_connected: bool
    last_check: str

@dataclass
class LoadedModel:
    name: str
    model: Any
    feature_extractor: Any
    version: str
    loaded_at: datetime
    prediction_count: int
    total_latency: float

class ModelRegistry:
    """Manages loaded models and versioning"""

    def __init__(self, models_path: str = "./models"):
        self.models_path = models_path
        self.models: Dict[str, LoadedModel] = {}
        self.default_model = "ensemble"

    def load_model(self, model_name: str) -> LoadedModel:
        """Load a model from disk"""
        # Find latest version
        model_files = [
            f for f in os.listdir(self.models_path)
            if f.startswith(model_name) and f.endswith('.pkl')
        ]

        if not model_files:
            raise ValueError(f"No model found for {model_name}")

        # Sort by timestamp in filename
        latest_file = sorted(model_files)[-1]
        model_path = os.path.join(self.models_path, latest_file)

        logger.info(f"Loading model from {model_path}")
        saved = joblib.load(model_path)

        loaded = LoadedModel(
            name=model_name,
            model=saved.get('model'),
            feature_extractor=saved.get('feature_extractor'),
            version=saved.get('timestamp', 'unknown'),
            loaded_at=datetime.now(),
            prediction_count=0,
            total_latency=0.0
        )

        self.models[model_name] = loaded
        ACTIVE_MODELS.set(len(self.models))
        MODEL_VERSION.labels(model_name=model_name, version=loaded.version).set(1)

        logger.info(f"Loaded model {model_name} version {loaded.version}")
        return loaded

    def get_model(self, model_name: str) -> LoadedModel:
        """Get loaded model or load it"""
        if model_name not in self.models:
            self.load_model(model_name)
        return self.models[model_name]

    def reload_model(self, model_name: str) -> LoadedModel:
        """Force reload a model"""
        if model_name in self.models:
            # Reset metric
            MODEL_VERSION.labels(
                model_name=model_name,
                version=self.models[model_name].version
            ).set(0)
            del self.models[model_name]

        return self.load_model(model_name)

    def list_models(self) -> List[ModelInfo]:
        """List all loaded models"""
        infos = []
        for name, loaded in self.models.items():
            avg_latency = (
                loaded.total_latency / loaded.prediction_count
                if loaded.prediction_count > 0
                else 0
            )
            infos.append(ModelInfo(
                name=name,
                version=loaded.version,
                loaded_at=loaded.loaded_at.isoformat(),
                last_prediction=str(loaded.prediction_count),
                total_predictions=loaded.prediction_count,
                avg_latency_ms=avg_latency * 1000
            ))
        return infos

class InferenceEngine:
    """Handles prediction logic with batching and caching"""

    def __init__(self, registry: ModelRegistry, redis_client: redis.Redis):
        self.registry = registry
        self.redis = redis_client
        self.cache_ttl = 300  # 5 minutes
        self.max_batch_size = 100

    async def predict(self, request: InferenceRequest) -> InferenceResponse:
        """Run inference on input features"""
        start_time = time.time()

        # Validate batch size
        if len(request.features) > self.max_batch_size:
            raise ValueError(f"Batch size {len(request.features)} exceeds max {self.max_batch_size}")

        # Check cache
        cached_result = None
        cache_key = None
        if request.use_cache:
            cache_key = self._generate_cache_key(request)
            cached_result = await self._get_cached_result(request.model_name, cache_key)

        if cached_result:
            CACHE_HITS.labels(model_name=request.model_name).inc()
            INFERENCE_COUNT.labels(model_name=request.model_name, status='cached').inc()
            cached_result['cached'] = True
            return InferenceResponse(**cached_result)

        CACHE_MISSES.labels(model_name=request.model_name).inc()

        # Get model
        try:
            loaded_model = self.registry.get_model(request.model_name)
        except Exception as e:
            INFERENCE_COUNT.labels(model_name=request.model_name, status='error').inc()
            raise HTTPException(status_code=404, detail=f"Model not found: {str(e)}")

        # Run inference
        try:
            predictions = await self._run_inference(loaded_model, request.features)
        except Exception as e:
            INFERENCE_COUNT.labels(model_name=request.model_name, status='error').inc()
            logger.error(f"Inference error: {e}")
            raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")

        inference_time = time.time() - start_time

        # Update metrics
        INFERENCE_COUNT.labels(model_name=request.model_name, status='success').inc()
        INFERENCE_LATENCY.labels(model_name=request.model_name).observe(inference_time)
        BATCH_SIZE.labels(model_name=request.model_name).observe(len(request.features))

        # Update model stats
        loaded_model.prediction_count += len(request.features)
        loaded_model.total_latency += inference_time

        # Build response
        response = InferenceResponse(
            model_name=request.model_name,
            model_version=loaded_model.version,
            predictions=predictions,
            batch_size=len(request.features),
            inference_time_ms=inference_time * 1000,
            request_id=request.request_id or f"req_{int(time.time() * 1000)}",
            cached=False
        )

        # Cache result
        if request.use_cache and cache_key:
            await self._cache_result(request.model_name, cache_key, response)

        return response

    async def _run_inference(
        self,
        loaded_model: LoadedModel,
        features: List[List[float]]
    ) -> List[AnomalyScore]:
        """Execute model inference"""
        X = np.array(features)

        model = loaded_model.model

        # Handle different model types
        if hasattr(model, 'score_samples'):
            # Isolation Forest or similar
            scores = model.score_samples(X)
            predictions = model.predict(X)
        elif hasattr(model, 'decision_function'):
            # SVM-like
            scores = model.decision_function(X)
            predictions = model.predict(X)
        else:
            # Generic predict
            predictions = model.predict(X)
            scores = predictions.astype(float)

        # Convert to anomaly scores
        results = []
        for i in range(len(X)):
            # Normalize score to 0-1 (higher = more anomalous)
            raw_score = -scores[i] if hasattr(model, 'score_samples') else scores[i]
            normalized_score = 1 / (1 + np.exp(-raw_score))  # Sigmoid

            is_anomaly = predictions[i] == -1 if hasattr(model, 'score_samples') else bool(predictions[i])

            # Confidence based on distance from decision boundary
            confidence = abs(normalized_score - 0.5) * 2

            results.append(AnomalyScore(
                score=float(normalized_score),
                is_anomaly=is_anomaly,
                confidence=float(confidence),
                timestamp=datetime.now().isoformat()
            ))

        return results

    def _generate_cache_key(self, request: InferenceRequest) -> str:
        """Generate cache key from request"""
        import hashlib
        features_str = json.dumps(request.features, sort_keys=True)
        hash_input = f"{request.model_name}:{features_str}"
        return hashlib.sha256(hash_input.encode()).hexdigest()[:32]

    async def _get_cached_result(
        self,
        model_name: str,
        cache_key: str
    ) -> Optional[Dict]:
        """Retrieve cached inference result"""
        try:
            key = f"inference:{model_name}:{cache_key}"
            cached = await self.redis.get(key)
            if cached:
                return json.loads(cached)
        except Exception as e:
            logger.warning(f"Cache read error: {e}")
        return None

    async def _cache_result(
        self,
        model_name: str,
        cache_key: str,
        response: InferenceResponse
    ) -> None:
        """Cache inference result"""
        try:
            key = f"inference:{model_name}:{cache_key}"
            await self.redis.setex(
                key,
                self.cache_ttl,
                json.dumps(response.dict())
            )
        except Exception as e:
            logger.warning(f"Cache write error: {e}")

# Create FastAPI app
app = FastAPI(
    title="Oracle ML Model Server",
    description="Production inference server for anomaly detection models",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global instances
registry: Optional[ModelRegistry] = None
engine: Optional[InferenceEngine] = None
redis_client: Optional[redis.Redis] = None
start_time: float = time.time()

@app.on_event("startup")
async def startup():
    global registry, engine, redis_client

    models_path = os.getenv("MODEL_PATH", "./models")
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")

    # Connect to Redis
    redis_client = redis.from_url(redis_url)
    await redis_client.ping()
    logger.info("Connected to Redis")

    # Initialize registry and engine
    registry = ModelRegistry(models_path)
    engine = InferenceEngine(registry, redis_client)

    # Pre-load default models
    try:
        registry.load_model("ensemble")
    except Exception as e:
        logger.warning(f"Could not pre-load ensemble model: {e}")

    logger.info("Model server started")

@app.on_event("shutdown")
async def shutdown():
    if redis_client:
        await redis_client.close()
    logger.info("Model server stopped")

@app.get("/v1/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    redis_ok = False
    try:
        await redis_client.ping()
        redis_ok = True
    except Exception:
        pass

    return HealthResponse(
        status="healthy" if redis_ok else "degraded",
        models_loaded=len(registry.models) if registry else 0,
        uptime_seconds=time.time() - start_time,
        redis_connected=redis_ok,
        last_check=datetime.now().isoformat()
    )

@app.get("/v1/models", response_model=List[ModelInfo])
async def list_models():
    """List all loaded models"""
    return registry.list_models()

@app.post("/v1/models/{model_name}/reload")
async def reload_model(model_name: str):
    """Reload a specific model"""
    try:
        loaded = registry.reload_model(model_name)
        return {
            "status": "reloaded",
            "model_name": model_name,
            "version": loaded.version
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/predict", response_model=InferenceResponse)
async def predict(request: InferenceRequest):
    """Run inference on input features"""
    return await engine.predict(request)

@app.post("/v1/predict/anomaly")
async def predict_anomaly(
    model_name: str = "ensemble",
    features: List[float] = None
):
    """Simple single-sample anomaly prediction"""
    if features is None or len(features) == 0:
        raise HTTPException(status_code=400, detail="Features required")

    request = InferenceRequest(
        model_name=model_name,
        features=[features],
        use_cache=True
    )

    response = await engine.predict(request)
    return response.predictions[0]

@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint"""
    return Response(
        content=generate_latest(),
        media_type="text/plain"
    )

@app.get("/v1/stats")
async def get_stats():
    """Get server statistics"""
    return {
        "uptime_seconds": time.time() - start_time,
        "models": registry.list_models(),
        "total_predictions": sum(
            m.prediction_count for m in registry.models.values()
        ),
        "redis_connected": redis_client is not None,
        "timestamp": datetime.now().isoformat()
    }

if __name__ == "__main__":
    uvicorn.run(
        "model_server:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8001")),
        workers=int(os.getenv("NUM_WORKERS", "4")),
        log_level="info"
    )
