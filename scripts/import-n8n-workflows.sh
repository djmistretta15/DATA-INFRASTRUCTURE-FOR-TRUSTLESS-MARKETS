#!/bin/bash

# Import all n8n workflows at once
# This script copies workflows to n8n's import directory

echo "🎨 GP4U-Mk-2 n8n Workflow Importer"
echo "=================================="
echo ""

# Check if n8n container is running
if ! docker ps | grep -q gpu-n8n; then
    echo "❌ n8n container not running!"
    echo "Start it first: cd infra && docker compose up -d n8n"
    exit 1
fi

echo "✅ n8n container is running"
echo ""

# List of workflows to import
WORKFLOWS=(
    "n8n/gpu-rental-workflow.json"
    "n8n/workflows/node-get-provider-prices.json"
    "n8n/workflows/node-find-best-price.json"
    "n8n/workflows/node-check-arbitrage-opportunity.json"
    "n8n/workflows/node-send-discord-alert.json"
    "n8n/workflows/node-create-user.json"
    "n8n/workflows/node-track-referral.json"
)

echo "📦 Available workflows to import:"
for workflow in "${WORKFLOWS[@]}"; do
    if [ -f "$workflow" ]; then
        echo "  ✓ $workflow"
    else
        echo "  ✗ $workflow (not found)"
    fi
done

echo ""
echo "To import these workflows:"
echo ""
echo "Option 1: Via n8n UI (Recommended)"
echo "  1. Open http://localhost:5678"
echo "  2. Click 'Workflows' → 'Import from file'"
echo "  3. Select each JSON file listed above"
echo ""
echo "Option 2: Copy files to n8n container"
echo "  Run this command for each workflow:"
echo "  docker cp <workflow-file> gpu-n8n:/home/node/.n8n/workflows/"
echo ""
echo "Option 3: Direct file access"
echo "  The workflow files are in your current directory at:"
echo "  $(pwd)/n8n/"
echo ""
echo "🎯 Quick Start:"
echo "  1. Open n8n UI: http://localhost:5678"
echo "  2. Import the main workflow first: n8n/gpu-rental-workflow.json"
echo "  3. Then import the 6 atomic nodes from n8n/workflows/"
echo ""
