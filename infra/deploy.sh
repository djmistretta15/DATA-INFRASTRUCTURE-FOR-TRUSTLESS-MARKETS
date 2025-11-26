#!/bin/bash
set -e

# GPU Black Market 2.0 - VPS Deployment Script
# Usage: ./deploy.sh

echo "🚀 GPU Black Market 2.0 - Deployment Script"
echo "============================================"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "⚠️  Please run as root or with sudo"
  exit 1
fi

# Update system
echo "📦 Updating system packages..."
apt-get update
apt-get upgrade -y

# Install Docker
if ! command -v docker &> /dev/null; then
    echo "🐳 Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    systemctl enable docker
    systemctl start docker
else
    echo "✓ Docker already installed"
fi

# Install Docker Compose plugin
if ! docker compose version &> /dev/null; then
    echo "🔧 Installing Docker Compose..."
    apt-get install -y docker-compose-plugin
else
    echo "✓ Docker Compose already installed"
fi

# Install git if not present
if ! command -v git &> /dev/null; then
    echo "📥 Installing git..."
    apt-get install -y git
fi

# Setup project directory
PROJECT_DIR="/opt/gpu-black-market"
echo "📂 Setting up project directory at $PROJECT_DIR..."

if [ ! -d "$PROJECT_DIR" ]; then
    echo "Please enter your Git repository URL:"
    read -r REPO_URL
    git clone "$REPO_URL" "$PROJECT_DIR"
else
    echo "✓ Project directory already exists"
    cd "$PROJECT_DIR"
    git pull
fi

cd "$PROJECT_DIR"

# Check for .env file
if [ ! -f "infra/.env" ]; then
    echo "⚠️  .env file not found in infra/"
    echo "Copying from .env.example..."
    cp infra/.env.example infra/.env
    echo ""
    echo "🔐 IMPORTANT: Edit infra/.env with your actual credentials:"
    echo "   - Provider API keys"
    echo "   - n8n password"
    echo "   - Supabase credentials"
    echo ""
    read -p "Press Enter when you've edited the .env file..."
fi

# Setup Fail2Ban (basic SSH protection)
echo "🛡️  Setting up Fail2Ban..."
apt-get install -y fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# Create basic fail2ban config for SSH
cat > /etc/fail2ban/jail.local <<EOF
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
EOF

systemctl restart fail2ban

# Setup UFW firewall (basic)
echo "🔥 Configuring firewall..."
if command -v ufw &> /dev/null; then
    ufw --force reset
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow ssh
    ufw allow http
    ufw allow https
    ufw --force enable
    echo "✓ Firewall configured"
fi

# Build and start services
echo "🏗️  Building and starting services..."
cd "$PROJECT_DIR/infra"
docker compose down
docker compose build --no-cache
docker compose up -d

# Wait for services to be healthy
echo "⏳ Waiting for services to be healthy..."
sleep 10

# Check service status
echo ""
echo "📊 Service Status:"
docker compose ps

# Get service URLs
echo ""
echo "✅ Deployment complete!"
echo ""
echo "Services:"
echo "  - n8n:           http://localhost:5678"
echo "  - Price Engine:  http://localhost:8000"
echo "  - Uptime Kuma:   http://localhost:3001"
echo "  - Redis:         localhost:6379"
echo ""
echo "Next steps:"
echo "1. Configure n8n workflow (see n8n/FLOW_SPEC.md)"
echo "2. Setup Cloudflare Tunnel to expose services"
echo "3. Configure Supabase project"
echo "4. Deploy frontend (Vercel or Docker)"
echo ""
echo "Useful commands:"
echo "  - View logs:    docker compose logs -f"
echo "  - Restart:      docker compose restart"
echo "  - Stop:         docker compose down"
echo "  - Update:       git pull && docker compose up -d --build"
echo ""
