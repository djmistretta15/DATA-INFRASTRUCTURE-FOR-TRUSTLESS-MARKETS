#!/bin/bash
# Production Health Check Script
# Comprehensive health verification for oracle infrastructure

set -euo pipefail

# Configuration
NAMESPACE="${NAMESPACE:-reclaim-oracle}"
TIMEOUT="${TIMEOUT:-30}"
MAX_RETRIES="${MAX_RETRIES:-3}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
CHECKS_PASSED=0
CHECKS_FAILED=0
WARNINGS=0

# Logging functions
log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
  ((WARNINGS++))
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
  ((CHECKS_FAILED++))
}

log_success() {
  echo -e "${GREEN}[PASS]${NC} $1"
  ((CHECKS_PASSED++))
}

# Check if command exists
check_command() {
  if ! command -v "$1" &> /dev/null; then
    log_error "Required command not found: $1"
    exit 1
  fi
}

# Verify prerequisites
verify_prerequisites() {
  log_info "Verifying prerequisites..."
  check_command "kubectl"
  check_command "curl"
  check_command "jq"
  log_success "All prerequisites met"
}

# Check Kubernetes connectivity
check_k8s_connectivity() {
  log_info "Checking Kubernetes connectivity..."
  if kubectl cluster-info &> /dev/null; then
    log_success "Kubernetes cluster is accessible"
  else
    log_error "Cannot connect to Kubernetes cluster"
    exit 1
  fi
}

# Check namespace exists
check_namespace() {
  log_info "Checking namespace $NAMESPACE..."
  if kubectl get namespace "$NAMESPACE" &> /dev/null; then
    log_success "Namespace $NAMESPACE exists"
  else
    log_error "Namespace $NAMESPACE not found"
    exit 1
  fi
}

# Check pod status
check_pods() {
  log_info "Checking pod status..."

  local not_running
  not_running=$(kubectl get pods -n "$NAMESPACE" --no-headers | grep -v "Running\|Completed" | wc -l)

  if [ "$not_running" -eq 0 ]; then
    log_success "All pods are running"
  else
    log_error "$not_running pods are not in Running state"
    kubectl get pods -n "$NAMESPACE" --no-headers | grep -v "Running\|Completed"
  fi

  # Check for restart loops
  local high_restarts
  high_restarts=$(kubectl get pods -n "$NAMESPACE" -o json | jq -r '.items[] | select(.status.containerStatuses[].restartCount > 5) | .metadata.name')

  if [ -n "$high_restarts" ]; then
    log_warn "Pods with high restart count: $high_restarts"
  else
    log_success "No pods with excessive restarts"
  fi
}

# Check deployments
check_deployments() {
  log_info "Checking deployments..."

  local deployments=("oracle-api" "oracle-indexer" "ml-detector" "ws-server" "graphql-server")

  for deployment in "${deployments[@]}"; do
    local ready
    ready=$(kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    local desired
    desired=$(kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")

    if [ "$ready" -eq "$desired" ] && [ "$desired" -gt 0 ]; then
      log_success "Deployment $deployment: $ready/$desired replicas ready"
    else
      log_error "Deployment $deployment: $ready/$desired replicas ready"
    fi
  done
}

# Check API health
check_api_health() {
  log_info "Checking API health endpoints..."

  local api_endpoint
  api_endpoint=$(kubectl get svc oracle-api -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}')

  local response
  response=$(kubectl exec -n "$NAMESPACE" deployment/oracle-api -- curl -sf "http://localhost:3000/v1/health" 2>/dev/null || echo "{}")

  local status
  status=$(echo "$response" | jq -r '.status' 2>/dev/null || echo "unknown")

  if [ "$status" == "healthy" ]; then
    log_success "API health check passed"
  else
    log_error "API health check failed: $status"
  fi
}

# Check database connectivity
check_database() {
  log_info "Checking database connectivity..."

  local db_status
  db_status=$(kubectl exec -n "$NAMESPACE" deployment/oracle-api -- node -e "
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    prisma.\$queryRaw\`SELECT 1\`.then(() => console.log('OK')).catch(e => console.log('ERROR'));
  " 2>/dev/null || echo "ERROR")

  if [ "$db_status" == "OK" ]; then
    log_success "Database connectivity OK"
  else
    log_error "Database connectivity failed"
  fi
}

# Check Redis connectivity
check_redis() {
  log_info "Checking Redis connectivity..."

  local redis_ping
  redis_ping=$(kubectl exec -n "$NAMESPACE" deployment/oracle-api -- node -e "
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL);
    redis.ping().then(() => { console.log('PONG'); redis.quit(); }).catch(e => console.log('ERROR'));
  " 2>/dev/null || echo "ERROR")

  if [ "$redis_ping" == "PONG" ]; then
    log_success "Redis connectivity OK"
  else
    log_error "Redis connectivity failed"
  fi
}

# Check ML model serving
check_ml_service() {
  log_info "Checking ML model service..."

  local ml_health
  ml_health=$(kubectl exec -n "$NAMESPACE" deployment/ml-detector -- curl -sf "http://localhost:8001/v1/health" 2>/dev/null || echo "{}")

  local models_loaded
  models_loaded=$(echo "$ml_health" | jq -r '.models_loaded' 2>/dev/null || echo "0")

  if [ "$models_loaded" -gt 0 ]; then
    log_success "ML service healthy with $models_loaded models loaded"
  else
    log_warn "ML service has no models loaded"
  fi
}

# Check WebSocket service
check_websocket() {
  log_info "Checking WebSocket service..."

  local ws_health
  ws_health=$(kubectl exec -n "$NAMESPACE" deployment/ws-server -- curl -sf "http://localhost:3001/health" 2>/dev/null || echo "{}")

  local status
  status=$(echo "$ws_health" | jq -r '.status' 2>/dev/null || echo "unknown")

  if [ "$status" == "ok" ] || [ "$status" == "healthy" ]; then
    log_success "WebSocket service healthy"
  else
    log_error "WebSocket service unhealthy: $status"
  fi
}

# Check GraphQL service
check_graphql() {
  log_info "Checking GraphQL service..."

  local gql_health
  gql_health=$(kubectl exec -n "$NAMESPACE" deployment/graphql-server -- curl -sf "http://localhost:4000/.well-known/apollo/server-health" 2>/dev/null || echo "{}")

  local status
  status=$(echo "$gql_health" | jq -r '.status' 2>/dev/null || echo "unknown")

  if [ "$status" == "pass" ]; then
    log_success "GraphQL service healthy"
  else
    log_error "GraphQL service unhealthy"
  fi
}

# Check persistent volumes
check_persistent_volumes() {
  log_info "Checking persistent volumes..."

  local pvc_issues
  pvc_issues=$(kubectl get pvc -n "$NAMESPACE" --no-headers | grep -v "Bound" | wc -l)

  if [ "$pvc_issues" -eq 0 ]; then
    log_success "All PVCs are bound"
  else
    log_error "$pvc_issues PVCs are not bound"
    kubectl get pvc -n "$NAMESPACE" --no-headers | grep -v "Bound"
  fi
}

# Check HPA status
check_autoscaling() {
  log_info "Checking horizontal pod autoscaling..."

  local hpas
  hpas=$(kubectl get hpa -n "$NAMESPACE" -o json)

  local hpa_count
  hpa_count=$(echo "$hpas" | jq -r '.items | length')

  if [ "$hpa_count" -gt 0 ]; then
    log_success "Found $hpa_count HPA configurations"

    # Check if any HPA is at max
    local at_max
    at_max=$(echo "$hpas" | jq -r '.items[] | select(.status.currentReplicas >= .spec.maxReplicas) | .metadata.name')

    if [ -n "$at_max" ]; then
      log_warn "HPAs at maximum capacity: $at_max"
    fi
  else
    log_warn "No HPA configurations found"
  fi
}

# Check network policies
check_network_policies() {
  log_info "Checking network policies..."

  local netpol_count
  netpol_count=$(kubectl get networkpolicies -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l)

  if [ "$netpol_count" -gt 0 ]; then
    log_success "Found $netpol_count network policies"
  else
    log_warn "No network policies found"
  fi
}

# Check resource utilization
check_resource_utilization() {
  log_info "Checking resource utilization..."

  if kubectl top pods -n "$NAMESPACE" &> /dev/null; then
    # Check for high CPU usage
    local high_cpu
    high_cpu=$(kubectl top pods -n "$NAMESPACE" --no-headers | awk '$2 ~ /[0-9]+m$/ { gsub(/m$/,"",$2); if ($2 > 800) print $1 }')

    if [ -n "$high_cpu" ]; then
      log_warn "Pods with high CPU usage: $high_cpu"
    else
      log_success "CPU utilization within normal range"
    fi

    # Check for high memory usage
    local high_mem
    high_mem=$(kubectl top pods -n "$NAMESPACE" --no-headers | awk '$3 ~ /[0-9]+Mi$/ { gsub(/Mi$/,"",$3); if ($3 > 1500) print $1 }')

    if [ -n "$high_mem" ]; then
      log_warn "Pods with high memory usage: $high_mem"
    else
      log_success "Memory utilization within normal range"
    fi
  else
    log_warn "Metrics server not available"
  fi
}

# Check Oracle feed freshness
check_oracle_feeds() {
  log_info "Checking oracle feed freshness..."

  local feeds_status
  feeds_status=$(kubectl exec -n "$NAMESPACE" deployment/oracle-api -- curl -sf "http://localhost:3000/v1/oracle/status" 2>/dev/null || echo "{}")

  local stale_feeds
  stale_feeds=$(echo "$feeds_status" | jq -r '.staleFeeds // 0' 2>/dev/null)

  if [ "$stale_feeds" -eq 0 ]; then
    log_success "All oracle feeds are fresh"
  else
    log_error "$stale_feeds oracle feeds are stale"
  fi
}

# Check error rates from Prometheus
check_error_rates() {
  log_info "Checking error rates..."

  # Try to query Prometheus directly
  local prom_service
  prom_service=$(kubectl get svc -n "$NAMESPACE" -l app=prometheus -o jsonpath='{.items[0].spec.clusterIP}' 2>/dev/null || echo "")

  if [ -n "$prom_service" ]; then
    local error_rate
    error_rate=$(kubectl exec -n "$NAMESPACE" deployment/oracle-api -- curl -sf "http://$prom_service:9090/api/v1/query?query=rate(http_requests_total{status=~\"5..\"}[5m])" 2>/dev/null | jq -r '.data.result[0].value[1] // 0')

    if (( $(echo "$error_rate < 0.01" | bc -l) )); then
      log_success "Error rate is low: $error_rate"
    else
      log_error "High error rate detected: $error_rate"
    fi
  else
    log_warn "Prometheus service not found"
  fi
}

# Check circuit breakers
check_circuit_breakers() {
  log_info "Checking circuit breaker status..."

  local cb_status
  cb_status=$(kubectl exec -n "$NAMESPACE" deployment/oracle-api -- curl -sf "http://localhost:3000/v1/oracle/circuit-breakers" 2>/dev/null || echo "{}")

  local open_breakers
  open_breakers=$(echo "$cb_status" | jq -r '.openBreakers // 0' 2>/dev/null)

  if [ "$open_breakers" -eq 0 ]; then
    log_success "No circuit breakers are open"
  else
    log_error "$open_breakers circuit breakers are open"
  fi
}

# Generate summary report
generate_summary() {
  echo ""
  echo "========================================="
  echo "           HEALTH CHECK SUMMARY          "
  echo "========================================="
  echo -e "Checks Passed: ${GREEN}$CHECKS_PASSED${NC}"
  echo -e "Checks Failed: ${RED}$CHECKS_FAILED${NC}"
  echo -e "Warnings:      ${YELLOW}$WARNINGS${NC}"
  echo "========================================="

  if [ "$CHECKS_FAILED" -gt 0 ]; then
    echo -e "${RED}OVERALL STATUS: UNHEALTHY${NC}"
    exit 1
  elif [ "$WARNINGS" -gt 3 ]; then
    echo -e "${YELLOW}OVERALL STATUS: DEGRADED${NC}"
    exit 0
  else
    echo -e "${GREEN}OVERALL STATUS: HEALTHY${NC}"
    exit 0
  fi
}

# Main execution
main() {
  echo "========================================="
  echo "    Oracle Infrastructure Health Check   "
  echo "========================================="
  echo "Namespace: $NAMESPACE"
  echo "Time: $(date)"
  echo ""

  verify_prerequisites
  check_k8s_connectivity
  check_namespace
  check_pods
  check_deployments
  check_api_health
  check_database
  check_redis
  check_ml_service
  check_websocket
  check_graphql
  check_persistent_volumes
  check_autoscaling
  check_network_policies
  check_resource_utilization
  check_oracle_feeds
  check_error_rates
  check_circuit_breakers

  generate_summary
}

# Run main function
main "$@"
