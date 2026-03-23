#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2024-2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Ambient Scribe Bootstrap Script
# This script sets up the development environment

set -e

echo "Bootstrapping Ambient Scribe Development Environment"
echo "======================================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is installed and running
check_docker() {
    log_info "Checking Docker installation..."
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        log_error "Docker is not running. Please start Docker first."
        exit 1
    fi
    
    log_success "Docker is installed and running"
}

# Check if Docker Compose is available
check_docker_compose() {
    log_info "Checking Docker Compose..."
    
    if ! command -v docker compose &> /dev/null; then
        log_error "Docker Compose is not available. Please install Docker Compose."
        exit 1
    fi
    
    log_success "Docker Compose is available"
}

# Check system requirements
check_requirements() {
    log_info "Checking system requirements..."
    
    # Check available memory
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        MEM_GB=$(free -g | awk '/^Mem:/{print $2}')
        if [ "$MEM_GB" -lt 8 ]; then
            log_warning "Less than 8GB RAM detected. Performance may be affected."
        fi
    fi
    
    # Check disk space
    DISK_SPACE=$(df -BG . | awk 'NR==2 {print $4}' | sed 's/G//')
    if [ "$DISK_SPACE" -lt 10 ]; then
        log_warning "Less than 10GB disk space available. May need more space for Docker images."
    fi
    
    log_success "System requirements check completed"
}

# Create environment file
setup_environment() {
    log_info "Setting up environment configuration..."
    
    # Setup API environment file
    if [ ! -f "apps/api/.env" ]; then
        if [ -f "apps/api/dot_env_example" ]; then
            cp apps/api/dot_env_example apps/api/.env
            log_success "API environment file created from template"
            log_warning "Please edit apps/api/.env with your API keys and configuration"
        else
            log_error "API environment template not found"
            exit 1
        fi
    else
        log_info "API environment file already exists"
    fi
    
    # Setup UI environment file
    if [ ! -f "apps/ui/.env" ]; then
        log_info "Creating UI environment file..."
        cat > apps/ui/.env << 'EOF'
# Frontend Environment Variables for Ambient Scribe UI
VITE_USE_STREAMING=true
EOF
        log_success "UI environment file created"
    else
        log_info "UI environment file already exists"
    fi
}

# Create necessary directories
create_directories() {
    log_info "Creating necessary directories..."
    
    for dir in apps/api/uploads apps/api/logs; do
        if [ -d "$dir" ]; then
            log_info "Directory already exists: $dir"
        else
            mkdir -p "$dir"
            log_success "Created directory: $dir"
        fi
    done
    
    log_success "Directories created"
}


# Set directory permissions
set_directory_permissions() {
    log_info "Setting directory permissions..."
    
    # Ensure uploads directory is world-writable for Docker and local workflows
    if [ -d "apps/api/uploads" ]; then
        chmod 777 apps/api/uploads
        log_info "Set permissions 777 on apps/api/uploads"
    fi
    
    log_success "Directory permissions set"
}

# Install Node.js dependencies (if developing locally)
install_ui_deps() {
    if command -v npm &> /dev/null && [ -d "apps/ui" ]; then
        log_info "Installing UI dependencies..."
        cd apps/ui
        npm install npm install --force --progress=true --loglevel=info
        cd ../..
        log_success "UI dependencies installed"
    else
        log_info "Skipping UI dependencies (will be installed in Docker)"
    fi
}

# Install Python dependencies (if developing locally)
install_api_deps() {
    if command -v python3 &> /dev/null && [ -d "apps/api" ]; then
        log_info "Installing API dependencies..."
        cd apps/api
        if command -v uv &> /dev/null; then
            uv pip install -e ".[dev]"
        elif [ -f ".venv/bin/activate" ]; then
            source .venv/bin/activate
            pip install -e ".[dev]"
        else
            log_info "Skipping API dependencies (will be installed in Docker)"
        fi
        cd ../..
        log_success "API dependencies installed"
    else
        log_info "Skipping API dependencies (will be installed in Docker)"
    fi
}

# Seed initial templates
seed_templates() {
    log_info "Seeding initial templates..."
    
    if [ -f "scripts/seed_templates.py" ]; then
        python3 scripts/seed_templates.py
        log_success "Templates seeded"
    else
        log_warning "Template seeding script not found"
    fi
}

# Pull base Docker images
pull_base_images() {
    log_info "Pulling base Docker images..."
    
    docker pull python:3.11-slim
    docker pull node:20-alpine
    docker pull nginx:1.27-alpine
    
    log_success "Base images pulled"
}

# Build development images
build_dev_images() {
    log_info "Building development Docker images..."
    
    docker compose -f infra/compose.dev.yml build
    
    log_success "Development images built"
}

# Run health checks
health_check() {
    log_info "Running health checks..."
    
    # Start services
    docker compose -f infra/compose.dev.yml up -d
    
    # Wait for services to be ready
    sleep 30
    
    # Check API health
    if curl -f http://localhost:8000/api/health/ &> /dev/null; then
        log_success "API is healthy"
    else
        log_warning "API health check failed (may need API keys configured)"
    fi
    
    # Check UI
    if curl -f http://localhost:5173/ &> /dev/null; then
        log_success "UI is accessible"
    else
        log_warning "UI health check failed"
    fi
    
    # Stop services
    docker compose -f infra/compose.dev.yml down
}

# Main bootstrap function
main() {
    echo ""
    log_info "Starting bootstrap process..."
    
    check_docker
    check_docker_compose
    check_requirements
    setup_environment
    create_directories
    set_directory_permissions
    build_dev_images
    
    # Optional local development setup
    install_ui_deps
    install_api_deps
    seed_templates
    
    echo ""
    log_success "Bootstrap completed successfully!"
    echo ""
    echo "Next steps:"
    echo "1. Edit apps/api/.env with your API keys"
    echo "2. Run 'make dev' to start development environment"
    echo "3. Visit http://localhost:5173 for the UI"
    echo "4. Visit http://localhost:8000/api/docs for API documentation"
    echo ""
    echo "For help: make help"
    echo ""
}

# Run main function
main "$@"
