#!/bin/bash

# GPU Black Market 2.0 - Mobile Management Script
# Optimized for Terminus on iPad and mobile terminals
# Usage: ./manage.sh [command]

set -e

# Colors for output (works in most terminals including Terminus)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Project paths
PROJECT_DIR="/opt/gpu-black-market"
INFRA_DIR="$PROJECT_DIR/infra"

# Helper functions
print_header() {
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

# Check if we're in the right directory
if [ ! -d "$INFRA_DIR" ]; then
    INFRA_DIR="./infra"
fi

# Commands
cmd_status() {
    print_header "Service Status"
    cd "$INFRA_DIR"
    docker compose ps
    echo ""
    print_info "Quick health checks:"
    curl -s http://localhost:8000/health | jq '.' || print_warning "Price engine offline"
    curl -s http://localhost:8001/health | jq '.' || print_warning "PyFlow offline"
    curl -s http://localhost:5678 >/dev/null && print_success "n8n online" || print_warning "n8n offline"
}

cmd_start() {
    print_header "Starting All Services"
    cd "$INFRA_DIR"
    docker compose up -d
    print_success "Services started"
    echo ""
    cmd_status
}

cmd_stop() {
    print_header "Stopping All Services"
    cd "$INFRA_DIR"
    docker compose down
    print_success "Services stopped"
}

cmd_restart() {
    print_header "Restarting All Services"
    cmd_stop
    sleep 2
    cmd_start
}

cmd_logs() {
    print_header "Service Logs"
    cd "$INFRA_DIR"

    SERVICE="${1:-}"

    if [ -z "$SERVICE" ]; then
        print_info "Available services: n8n, redis, price-engine, pyflow, uptime-kuma"
        print_info "Usage: ./manage.sh logs [service]"
        print_info "Showing all logs..."
        docker compose logs --tail=50 --follow
    else
        print_info "Showing logs for: $SERVICE"
        docker compose logs --tail=50 --follow "$SERVICE"
    fi
}

cmd_update() {
    print_header "Updating from Git"
    cd "$PROJECT_DIR"

    # Stash any local changes
    git stash

    # Pull latest
    BRANCH=$(git branch --show-current)
    print_info "Pulling latest from $BRANCH..."
    git pull origin "$BRANCH"

    print_success "Code updated"

    # Rebuild and restart
    print_info "Rebuilding containers..."
    cd "$INFRA_DIR"
    docker compose build --no-cache
    docker compose up -d

    print_success "Services updated and restarted"
}

cmd_backup() {
    print_header "Creating Backup"
    BACKUP_DIR="$PROJECT_DIR/backups"
    mkdir -p "$BACKUP_DIR"

    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="$BACKUP_DIR/backup_$TIMESTAMP.tar.gz"

    print_info "Backing up volumes and configs..."

    cd "$INFRA_DIR"
    docker compose down

    tar -czf "$BACKUP_FILE" \
        --exclude='node_modules' \
        --exclude='__pycache__' \
        --exclude='.git' \
        -C "$PROJECT_DIR" .

    docker compose up -d

    print_success "Backup created: $BACKUP_FILE"

    # Keep only last 7 backups
    cd "$BACKUP_DIR"
    ls -t backup_*.tar.gz | tail -n +8 | xargs -r rm
    print_info "Cleaned old backups (keeping last 7)"
}

cmd_health() {
    print_header "Health Check"

    check_service() {
        SERVICE=$1
        URL=$2

        if curl -sf "$URL" >/dev/null 2>&1; then
            print_success "$SERVICE is healthy"
            return 0
        else
            print_error "$SERVICE is DOWN"
            return 1
        fi
    }

    HEALTHY=0

    check_service "Price Engine" "http://localhost:8000/health" || HEALTHY=1
    check_service "PyFlow" "http://localhost:8001/health" || HEALTHY=1
    check_service "n8n" "http://localhost:5678" || HEALTHY=1
    check_service "Redis" "http://localhost:6379" || HEALTHY=1
    check_service "Uptime Kuma" "http://localhost:3001" || HEALTHY=1

    echo ""
    if [ $HEALTHY -eq 0 ]; then
        print_success "All services healthy"
    else
        print_warning "Some services are unhealthy"
    fi

    return $HEALTHY
}

cmd_stats() {
    print_header "Resource Usage"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
}

cmd_shell() {
    SERVICE="${1:-price-engine}"
    print_header "Opening shell in: $SERVICE"
    cd "$INFRA_DIR"
    docker compose exec "$SERVICE" /bin/sh
}

cmd_redis() {
    print_header "Redis CLI"
    cd "$INFRA_DIR"
    docker compose exec redis redis-cli
}

cmd_quote() {
    print_header "Test GPU Quote"
    GPU_TYPE="${1:-H100}"

    print_info "Requesting quote for $GPU_TYPE..."

    curl -X POST http://localhost:8000/quote \
        -H "Content-Type: application/json" \
        -d "{
            \"gpu_type\": \"$GPU_TYPE\",
            \"vram_gb\": 80,
            \"hours\": 4,
            \"region\": \"any\",
            \"priority\": \"normal\"
        }" | jq '.'
}

cmd_arb() {
    print_header "Run Arbitrage Bot"

    print_info "Triggering arbitrage scan..."

    curl -X POST http://localhost:8001/flows/arbitrage/sync \
        -H "Content-Type: application/json" \
        -d '{
            "gpu_types": ["H100", "A100"],
            "min_margin_pct": 15.0,
            "execute_trades": false
        }' | jq '.'
}

cmd_help() {
    print_header "GPU Black Market Management"
    echo ""
    echo "Usage: ./manage.sh [command] [args]"
    echo ""
    echo "Service Management:"
    echo "  status          - Show service status"
    echo "  start           - Start all services"
    echo "  stop            - Stop all services"
    echo "  restart         - Restart all services"
    echo "  logs [service]  - Show logs (optionally for specific service)"
    echo ""
    echo "Maintenance:"
    echo "  update          - Pull latest code and restart"
    echo "  backup          - Create backup of all data"
    echo "  health          - Run health checks on all services"
    echo "  stats           - Show resource usage"
    echo ""
    echo "Development:"
    echo "  shell [service] - Open shell in container (default: price-engine)"
    echo "  redis           - Open Redis CLI"
    echo "  quote [gpu]     - Test quote endpoint (default: H100)"
    echo "  arb             - Run arbitrage bot scan"
    echo ""
    echo "Examples:"
    echo "  ./manage.sh status"
    echo "  ./manage.sh logs price-engine"
    echo "  ./manage.sh quote A100"
    echo "  ./manage.sh health"
}

# Main command router
COMMAND="${1:-help}"

case "$COMMAND" in
    status)
        cmd_status
        ;;
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    logs)
        cmd_logs "$2"
        ;;
    update)
        cmd_update
        ;;
    backup)
        cmd_backup
        ;;
    health)
        cmd_health
        ;;
    stats)
        cmd_stats
        ;;
    shell)
        cmd_shell "$2"
        ;;
    redis)
        cmd_redis
        ;;
    quote)
        cmd_quote "$2"
        ;;
    arb)
        cmd_arb
        ;;
    help|--help|-h)
        cmd_help
        ;;
    *)
        print_error "Unknown command: $COMMAND"
        echo ""
        cmd_help
        exit 1
        ;;
esac
